import { onRequest } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import crypto from "node:crypto";

const app = initializeApp();
const db  = getFirestore(app);

// ENV dari: firebase functions:config:set duitku.merchant_code="DXXXX" duitku.api_key="..." duitku.sign_algo="md5"
const MERCHANT_CODE = functions.config().duitku?.merchant_code || "";
const API_KEY       = functions.config().duitku?.api_key || "";
const SIGN_ALGO     = (functions.config().duitku?.sign_algo || "md5").toLowerCase();

function makeSignature(merchantCode, merchantOrderId, amount, apiKey) {
  const raw = merchantCode + merchantOrderId + amount + apiKey;
  return SIGN_ALGO === "sha256"
    ? crypto.createHash("sha256").update(raw).digest("hex")
    : crypto.createHash("md5").update(raw).digest("hex");
}

// ===== Create Invoice (HTTPS v2) =====
export const createDuitkuInvoice = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { amount, uid } = req.body || {};
    const realAmount = Number(amount || 0);
    if (!uid) return res.status(400).json({ error: "uid required" });
    if (!realAmount) return res.status(400).json({ error: "amount required" });

    // buat orderId & simpan pending
    const orderRef = db.collection("payments").doc();
    const orderId  = orderRef.id;
    await orderRef.set({
      uid,
      amount: realAmount,
      status: "PENDING",
      createdAt: FieldValue.serverTimestamp()
    });

    // siapkan payload ke Duitku
    const callbackUrl = `https://${process.env.GCLOUD_PROJECT}.web.app/duitku-callback`;
    const signature   = makeSignature(MERCHANT_CODE, orderId, realAmount, API_KEY);

    // NOTE: ganti ke endpoint SANDBOX bila akunmu sandbox
    const endpoint = "https://api-prod.duitku.com/api/merchant/createinvoice";

    const body = {
      merchantCode: MERCHANT_CODE,
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
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j?.paymentUrl) {
      console.error("DUITKU_ERR", { status: r.status, j });
      return res.status(500).json({ error: "duitku_failed", detail: j });
    }

    await orderRef.update({ paymentUrl: j.paymentUrl, ref: j.reference || null });

    return res.json({ paymentUrl: j.paymentUrl, orderId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

// ===== Callback/Notify (HTTPS v2) =====
export const duitkuCallback = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  try {
    const { merchantOrderId, resultCode } = req.body || {};
    if (!merchantOrderId) return res.status(400).send("no order id");

    const orderRef = db.collection("payments").doc(String(merchantOrderId));
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).send("order not found");

    await orderRef.update({
      status: resultCode === "00" ? "SUCCESS" : ("FAILED:" + resultCode),
      paidAt: FieldValue.serverTimestamp()
    });

    if (resultCode === "00") {
      const data = snap.data() || {};
      const uid  = data.uid;
      if (uid) {
        const vref = db.collection("vendors").doc(uid);
        await db.runTransaction(async (tx) => {
          const vs   = await tx.get(vref);
          const v    = vs.data() || {};
          const now  = Date.now();
          const base = (v.expiresAt && v.expiresAt > now) ? v.expiresAt : now;
          const newExp = base + (30 * 24 * 60 * 60 * 1000);
          tx.set(vref, { plan: "pro", expiresAt: newExp }, { merge: true });
        });
      }
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("ERR");
  }
});
