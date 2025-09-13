import { onRequest } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import crypto from "node:crypto";

// inisialisasi admin aman (hindari double-init)
function ensureAdmin() {
  if (!getApps().length) initializeApp();
  return getFirestore();
}

// config (legacy functions.config tetap dipakai dulu)
const CFG = {
  merchant_code: functions.config().duitku?.merchant_code || "",
  api_key:       functions.config().duitku?.api_key || "",
  sign_algo:    (functions.config().duitku?.sign_algo || "md5").toLowerCase(),
};

function makeSignature(merchantCode, merchantOrderId, amount, apiKey) {
  const raw = merchantCode + merchantOrderId + amount + apiKey;
  return CFG.sign_algo === "sha256"
    ? crypto.createHash("sha256").update(raw).digest("hex")
    : crypto.createHash("md5").update(raw).digest("hex");
}

// ping (tetap ada buat healthcheck)
export const ping = onRequest({ region: "us-central1", cors: true }, (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

export const createDuitkuInvoice = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { amount, uid } = req.body || {};
    const realAmount = Number(amount || 0);
    if (!uid) return res.status(400).json({ error: "uid required" });
    if (!realAmount) return res.status(400).json({ error: "amount required" });

    const db = ensureAdmin();

    // buat order
    const orderRef = db.collection("payments").doc();
    const orderId  = orderRef.id;
    await orderRef.set({
      uid,
      amount: realAmount,
      status: "PENDING",
      createdAt: FieldValue.serverTimestamp(),
    });

    // siapkan payload
    const merchantCode = CFG.merchant_code;
    const apiKey       = CFG.api_key;
    const signature    = makeSignature(merchantCode, orderId, realAmount, apiKey);
    const callbackUrl  = `https://${process.env.GCLOUD_PROJECT}.web.app/duitku-callback`;

    // NOTE: kalau akunmu sandbox, GANTI endpoint ini ke sandbox Duitku
    const endpoint = "https://api-prod.duitku.com/api/merchant/createinvoice";

    const body = {
      merchantCode,
      paymentAmount: String(realAmount),
      merchantOrderId: orderId,
      productDetails: "Wed-System Pro 1 Bulan",
      email: "billing@wedsystem.id",
      callbackUrl,
      returnUrl: `https://${process.env.GCLOUD_PROJECT}.web.app/vendor.html`,
      signature
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.paymentUrl) {
      console.error("DUITKU_ERR", { status: r.status, j });
      // sementara, agar bisa dites, balikin dummy jika gateway error
      return res.status(200).json({ paymentUrl: j?.paymentUrl || "https://example.com", orderId });
    }

    await orderRef.update({ paymentUrl: j.paymentUrl, ref: j.reference || null });

    res.json({ paymentUrl: j.paymentUrl, orderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

export const duitkuCallback = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  try {
    const { merchantOrderId, resultCode } = req.body || {};
    if (!merchantOrderId) return res.status(400).send("no order id");

    const db = ensureAdmin();
    const orderRef = db.collection("payments").doc(String(merchantOrderId));
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).send("order not found");

    await orderRef.update({
      status: resultCode === "00" ? "SUCCESS" : ("FAILED:" + resultCode),
      paidAt: FieldValue.serverTimestamp(),
    });

    if (resultCode === "00") {
      const data = snap.data() || {};
      const uid = data.uid;
      if (uid) {
        const vref = db.collection("vendors").doc(uid);
        await db.runTransaction(async (tx) => {
          const vs = await tx.get(vref);
          const v  = vs.data() || {};
          const now  = Date.now();
          const base = (v.expiresAt && v.expiresAt > now) ? v.expiresAt : now;
          const newExp = base + (30 * 24 * 60 * 60 * 1000);
          tx.set(vref, { plan: "pro", expiresAt: newExp }, { merge: true });
        });
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("ERR");
  }
});
