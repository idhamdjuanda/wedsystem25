import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import crypto from "node:crypto";

setGlobalOptions({ region: "us-central1", timeoutSeconds: 60, maxInstances: 3 });
initializeApp();
const db = getFirestore();

const ENV = process.env.MIDTRANS_ENV || "sandbox";
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || "";
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || "";
const SNAP_HOST = ENV === "production" ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com";
const API_HOST  = ENV === "production" ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
const SNAP_TX   = `${SNAP_HOST}/snap/v1/transactions`;

function allowCors(req, res) {
  const origin = req.headers.origin || "";
  const ok = /wedsystem25\.web\.app$/.test(origin) || /firebaseapp\.com$/.test(origin) || origin === "http://localhost:5000";
  if (ok) res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

export const ping = onRequest((req, res) => {
  if (allowCors(req, res)) return;
  res.json({ ok: true, now: Date.now(), env: ENV, hasServerKey: !!SERVER_KEY, hasClientKey: !!CLIENT_KEY });
});

async function requireUser(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("missing_auth");
  const token = m[1];
  const dec = await getAdminAuth().verifyIdToken(token);
  return { uid: dec.uid, email: dec.email || "" };
}

async function extendPlan(uid, addDays = 30) {
  const addMs = addDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const col of ["vendors", "vendor"]) {
    const ref = db.doc(`${col}/${uid}`);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const current = typeof data?.expiresAt === "number"
      ? data.expiresAt
      : (data?.expiresAt?._seconds ? data.expiresAt._seconds * 1000
        : (data?.expiresAt?.seconds ? data.expiresAt.seconds * 1000 : 0));
    const base = Math.max(current || 0, now);
    const next = base + addMs;
    await ref.set({ plan: "pro", expiresAt: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return true;
}

export const midtransCreate = onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!SERVER_KEY) return res.status(500).json({ error: "server_key_missing" });

    const { uid, email } = await requireUser(req);
    const gross_amount = 50000;
    const order_id = `wedsys_${uid}_${Date.now()}`;

    const payload = {
      transaction_details: { order_id, gross_amount },
      item_details: [{ id: "sub_30d", price: gross_amount, quantity: 1, name: "Wed-System PRO ? 30 hari" }],
      customer_details: { email: email || "user@wedsystem.id", first_name: "Vendor" },
      callbacks: { finish: "https://wedsystem25.web.app/midtrans-finish.html" },
      credit_card: { secure: true }
    };

    const auth = Buffer.from(`${SERVER_KEY}:`).toString("base64");
    const r = await fetch(SNAP_TX, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Basic ${auth}` },
      body: JSON.stringify(payload)
    });
    const j = await r.json();

    await db.collection("payments").doc(order_id).set({
      uid, order_id, gross_amount, env: ENV, status: "pending", redirect_url: j.redirect_url || null,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });

    if (!r.ok) {
      logger.error("midtransCreate error", { code: r.status, body: j });
      return res.status(r.status).json({ error: "midtrans_error", detail: j });
    }
    return res.json({ redirect_url: j.redirect_url, token: j.token, order_id });
  } catch (e) {
    logger.error("midtransCreate exception", e);
    return res.status(400).json({ error: String(e?.message || e) });
  }
});

export const midtransNotify = onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  try {
    const b = req.body || {};
    const { order_id = "", status_code = "", gross_amount = "", signature_key = "", transaction_status = "", fraud_status = "" } = b;

    const expected = crypto.createHash("sha512").update(`${order_id}${status_code}${gross_amount}${SERVER_KEY}`).digest("hex");
    if (expected !== (signature_key || "").toLowerCase()) {
      logger.warn("Bad signature", { order_id, status_code, gross_amount });
      return res.status(400).send("Bad Signature");
    }

    const m = order_id.match(/^wedsys_(.+?)_\d+$/);
    const uid = m ? m[1] : null;
    if (!uid) {
      logger.error("Cannot parse uid from order_id", { order_id });
      return res.status(400).json({ error: "bad_order_id" });
    }

    await db.collection("payments").doc(order_id).set({ ...b, notifyAt: FieldValue.serverTimestamp() }, { merge: true });

    const ok = (transaction_status === "settlement") || (transaction_status === "capture" && (fraud_status || "accept") === "accept");
    if (ok) {
      await extendPlan(uid, 30);
      logger.info("Plan extended via notify", { uid, order_id });
    }

    return res.json({ ok: true });
  } catch (e) {
    logger.error("midtransNotify exception", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Fallback: cek status langsung ke Midtrans, lalu extend kalau sukses
export const midtransSync = onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  try {
    const order_id = (req.method === "GET" ? req.query.order_id : req.body?.order_id) || "";
    if (!order_id) return res.status(400).json({ error: "missing_order_id" });
    if (!SERVER_KEY) return res.status(500).json({ error: "server_key_missing" });

    const m = order_id.match(/^wedsys_(.+?)_\d+$/);
    const uid = m ? m[1] : null;

    const auth = Buffer.from(`${SERVER_KEY}:`).toString("base64");
    const r = await fetch(`${API_HOST}/v2/${encodeURIComponent(order_id)}/status`, {
      headers: { "Accept": "application/json", "Authorization": `Basic ${auth}` }
    });
    const j = await r.json();

    const ok = (j.transaction_status === "settlement") || (j.transaction_status === "capture" && (j.fraud_status || "accept") === "accept");

    if (ok && uid) {
      await extendPlan(uid, 30);
      await db.collection("payments").doc(order_id).set({ status: "settlement", syncedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return res.json({ ok, status: j.transaction_status || null });
  } catch (e) {
    logger.error("midtransSync exception", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
