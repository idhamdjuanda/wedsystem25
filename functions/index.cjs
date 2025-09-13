const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

try { admin.initializeApp(); } catch (_) {}
const db = admin.firestore();

function cfg(){
  let fx={}; try{ fx=require("firebase-functions").config(); }catch(_){ fx={}; }
  const d = fx.midtrans || {};
  const env = (process.env.MIDTRANS_ENV || "sandbox").toLowerCase();
  return {
    env,
    baseUrl: env==="production" ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com",
    apiBase: env==="production" ? "https://app.midtrans.com/snap/v1" : "https://app.sandbox.midtrans.com/snap/v1",
    statusBase: env==="production" ? "https://api.midtrans.com/v2" : "https://api.sandbox.midtrans.com/v2",
    merchantId: process.env.MIDTRANS_MERCHANT_ID || d.merchant_id || "",
    clientKey:  process.env.MIDTRANS_CLIENT_KEY  || d.client_key  || "",
    serverKey:  process.env.MIDTRANS_SERVER_KEY  || d.server_key  || "",
    site: "https://wedsystem25.web.app",
    devToken: process.env.DEV_TOKEN || ""
  };
}

const ALLOW_ORIGINS = new Set([
  "https://wedsystem25.web.app",
  "https://wedsystem25.firebaseapp.com",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
]);
function withCORS(handler){
  return async (req,res)=>{
    const origin=req.headers.origin||"";
    const allowed = ALLOW_ORIGINS.has(origin)? origin : "*";
    res.set("Access-Control-Allow-Origin", allowed);
    res.set("Vary","Origin");
    res.set("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers","Content-Type, Authorization");
    if(req.method==="OPTIONS"){ res.status(204).send(""); return; }
    try{ await handler(req,res); }
    catch(e){ logger.error(e); res.status(500).json({error:"internal", message:String(e?.message||e)}); }
  };
}

// ------------ Helpers ------------
function sha512(s){ return crypto.createHash("sha512").update(s,"utf8").digest("hex"); }

async function updateVendorPlan(uid, days=30){
  const now = Date.now();
  const refs = [
    db.collection("vendors").doc(uid), // prefer ini
    db.collection("vendor").doc(uid),  // fallback jika UI baca koleksi singular
  ];
  const write = [];
  for(const ref of refs){
    write.push(ref.get().then(s=>{
      const data = s.exists ? s.data() : {};
      const curr = typeof data?.expiresAt === "number" ? data.expiresAt : 0;
      const base = now > curr ? now : curr;
      const newExp = base + days*24*60*60*1000;
      return ref.set({ plan:"pro", expiresAt:newExp }, { merge:true })
        .then(()=>({ path: ref.path, expiresAt: newExp }));
    }));
  }
  return Promise.allSettled(write);
}

async function savePayment(orderId, fields){
  try{
    await db.collection("payments").doc(orderId).set({
      ...fields,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
  }catch(e){ logger.warn("savePayment fail", e?.message); }
}

// ------------ Ping ------------
exports.ping = onRequest({ region:"us-central1" }, withCORS(async (req,res)=>{
  const c = cfg();
  res.json({ ok:true, now: Date.now(), env:c.env, merchant: c.merchantId ? "set":"missing" });
}));

// ------------ Midtrans: create transaction (Snap) ------------
exports.midtransCreate = onRequest({ region:"us-central1" }, withCORS(async (req,res)=>{
  if(req.method!=="POST"){ res.status(405).json({error:"method_not_allowed"}); return; }
  const c = cfg();
  if(!c.serverKey){ res.status(400).json({error:"config_missing"}); return; }

  const { amount, uid } = req.body || {};
  const gross = Number(amount||0);
  if(!uid || !gross || gross<1000){ res.status(400).json({error:"bad_request"}); return; }

  const orderId = `${uid}-${Date.now()}`.slice(0,64);

  const payload = {
    transaction_details: { order_id: orderId, gross_amount: gross },
    credit_card: { secure:true },
    callbacks: { finish: c.site + "/dashboardvendor" },
    customer_details: { first_name: uid.substring(0,20), email: "user@wedsystem.id" },
    item_details: [{ id:"wed-pro-30d", price:gross, quantity:1, name:"Wed-System PRO 30 hari" }]
  };
  const auth = "Basic " + Buffer.from(c.serverKey + ":").toString("base64");
  const r = await fetch(c.apiBase + "/transactions", {
    method:"POST", headers:{ "Content-Type":"application/json", "Authorization": auth }, body: JSON.stringify(payload)
  });
  const text = await r.text(); let j=null; try{ j=JSON.parse(text);}catch{}
  if(!r.ok){ logger.error("midtrans create fail", { status:r.status, text }); res.status(r.status).json({ error:"midtrans_fail", status:r.status, body:text }); return; }
  if(!j?.redirect_url){ res.status(400).json({ error:"midtrans_bad_response", j }); return; }

  await savePayment(orderId, { uid, amount:gross, provider:"midtrans", token: j.token||null, status:"PENDING", createdAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ redirect_url: j.redirect_url, token: j.token, order_id: orderId });
}));

// ------------ Midtrans: Notification (webhook) ------------
exports.midtransNotify = onRequest({ region:"us-central1" }, withCORS(async (req,res)=>{
  const c = cfg();
  const body = (req.headers["content-type"]||"").includes("application/json")
    ? (req.body||{})
    : Object.fromEntries(new URLSearchParams(req.rawBody?.toString()||""));

  const order_id = String(body.order_id||"");
  const status_code = String(body.status_code||"");
  const gross_amount = String(body.gross_amount||"");
  const signature_key = String(body.signature_key||"");
  const transaction_status = String(body.transaction_status||"");
  const fraud_status = String(body.fraud_status||"");

  const calc = sha512(order_id + status_code + gross_amount + c.serverKey);
  if(signature_key.toLowerCase() !== calc.toLowerCase()){
    logger.warn("midtrans bad signature", { order_id });
    res.status(403).send("Bad Signature"); return;
  }

  const uid = order_id.split("-")[0];
  const success = transaction_status==="settlement" || (transaction_status==="capture" && fraud_status==="accept");

  if(success && uid){ await updateVendorPlan(uid, 30); }
  await savePayment(order_id, { provider:"midtrans", status: success ? "SUCCESS": transaction_status.toUpperCase(), payload: body });

  res.status(200).send("OK");
}));

// ------------ Midtrans: Confirm by order_id ------------
exports.midtransConfirm = onRequest({ region:"us-central1" }, async (req,res)=>{
  try{
    const c = cfg();
    const order_id = String(req.query.order_id||"").trim();
    if(!order_id) { res.status(400).json({error:"missing_order_id"}); return; }
    if(!c.serverKey){ res.status(400).json({error:"config_missing"}); return; }

    const url = `${c.statusBase}/${encodeURIComponent(order_id)}/status`;
    const auth = "Basic " + Buffer.from(c.serverKey + ":").toString("base64");
    const r = await fetch(url, { headers: { "Authorization": auth } });
    const text = await r.text(); let j=null; try{ j=JSON.parse(text);}catch{}
    if(!r.ok){ logger.error("status fail", {status:r.status, text}); res.status(r.status).send(text); return; }

    const ts = String(j?.transaction_status||""); const fs = String(j?.fraud_status||"");
    const success = ts==="settlement" || (ts==="capture" && fs==="accept");
    const uid = order_id.split("-")[0];

    let writes = [];
    if(success && uid){ writes = await updateVendorPlan(uid, 30); }
    await savePayment(order_id, { provider:"midtrans", lastCheck: admin.firestore.FieldValue.serverTimestamp(), lastStatus: ts });

    res.json({ ok:true, order_id, transaction_status: ts, fraud_status: fs, success, updated: writes });
  }catch(e){ logger.error(e); res.status(500).json({error:"internal", message:String(e?.message||e)}); }
});

// ------------ DEV: Confirm by uid (tanpa butuh order_id, pakai token) ------------
exports.devConfirmByUid = onRequest({ region:"us-central1" }, async (req,res)=>{
  try{
    const c = cfg();
    const token = String(req.query.token||"");
    if(!c.devToken || token !== c.devToken){ res.status(403).json({error:"forbidden"}); return; }

    const uid = String(req.query.uid||"").trim();
    if(!uid){ res.status(400).json({error:"missing_uid"}); return; }
    if(!c.serverKey){ res.status(400).json({error:"config_missing"}); return; }

    // Ambil ~50 pembayaran terbaru, filter yang prefix order_id == `${uid}-`
    const snap = await db.collection("payments").orderBy("createdAt","desc").limit(50).get();
    const cand = [];
    snap.forEach(d=>{ const id = d.id||""; if(id.startsWith(uid+"-")) cand.push(id); });
    if(!cand.length){ res.status(404).json({error:"order_not_found_for_uid", uid}); return; }

    const order_id = cand[0];
    const url = `${c.statusBase}/${encodeURIComponent(order_id)}/status`;
    const auth = "Basic " + Buffer.from(c.serverKey + ":").toString("base64");
    const r = await fetch(url, { headers: { "Authorization": auth } });
    const text = await r.text(); let j=null; try{ j=JSON.parse(text);}catch{}
    if(!r.ok){ res.status(r.status).send(text); return; }

    const ts = String(j?.transaction_status||""); const fs = String(j?.fraud_status||"");
    const success = ts==="settlement" || (ts==="capture" && fs==="accept");

    let writes = [];
    if(success){ writes = await updateVendorPlan(uid, 30); }
    await savePayment(order_id, { provider:"midtrans", lastCheck: admin.firestore.FieldValue.serverTimestamp(), lastStatus: ts });

    res.json({ ok:true, uid, order_id, transaction_status: ts, fraud_status: fs, success, updated: writes });
  }catch(e){ logger.error(e); res.status(500).json({error:"internal", message:String(e?.message||e)}); }
});
exports.devSetPlan = onRequest({ region:"us-central1" }, async (req,res)=>{
  try{
    const c = cfg();
    const token = String(req.query.token||"");
    if(!c.devToken || token !== c.devToken){ res.status(403).json({error:"forbidden"}); return; }

    const uid  = String(req.query.uid||"").trim();
    const days = Number(req.query.days||30);
    if(!uid) { res.status(400).json({error:"missing_uid"}); return; }

    const writes = await updateVendorPlan(uid, days);
    // baca balik kedua path untuk verifikasi cepat
    const v1 = await db.collection("vendors").doc(uid).get();
    const v2 = await db.collection("vendor").doc(uid).get();
    res.json({
      ok:true, uid, days,
      writes,
      after: {
        vendors: v1.exists ? v1.data() : null,
        vendor:  v2.exists ? v2.data() : null
      }
    });
  }catch(e){
    res.status(500).json({error:"internal", message:String(e?.message||e)});
  }
});
// === midtransConfirmX: GET /midtrans/confirm?order_id=...&uid=...
exports.midtransConfirmX = onRequest({ region: "us-central1" }, async (req, res) => {
  try{
    const orderId = String(req.query.order_id||"").trim();
    let uid = String(req.query.uid||"").trim();
    if(!orderId) return res.status(400).json({ success:false, error:"missing_order_id" });

    const SK = process.env.MIDTRANS_SERVER_KEY;
    const ENV = process.env.MIDTRANS_ENV || "sandbox";
    if(!SK) return res.status(500).json({ success:false, error:"missing_server_key" });

    const base = (ENV==="production") ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
    const url  = `${base}/v2/${encodeURIComponent(orderId)}/status`;
    const auth = "Basic " + Buffer.from(SK + ":").toString("base64");

    const r   = await fetch(url, { headers: { Authorization: auth } });
    const js  = await r.json().catch(()=>({}));
    const ts  = js.transaction_status;
    const fr  = js.fraud_status;
    const ok  = (ts==="settlement") || (ts==="capture" && fr==="accept");

    // fallback cari uid dari mapping order jika tidak dikirim dari client
    if(!uid){
      try{
        const m = await db.collection("orders").doc(orderId).get();
        if(m.exists) uid = String(m.data().uid||"");
      }catch(e){}
    }

    if(ok && uid){
      await updateVendorPlan(uid, 30);
    }

    res.status(200).json({
      success: ok,
      transaction_status: ts||null,
      fraud_status: fr||null,
      uid: uid||null,
      raw: js
    });
  }catch(e){
    res.status(500).json({ success:false, error:String(e?.message||e) });
  }
});
'
# 3) Deploy functions + hosting
firebase deploy --only "functions" -P wedsystem25
firebase deploy --only "hosting"  -P wedsystem25

@'
/* override helper buat bikin URL confirm dengan uid */
function makeConfirmUrl(oid){
  let u = "/midtrans/confirm?order_id=" + encodeURIComponent(oid);
  try{
    const cu = (window.auth && window.auth.currentUser) ? window.auth.currentUser.uid : "";
    if(cu) u += "&uid=" + encodeURIComponent(cu);
  }catch(_){}
  return u;
}

/* patch autoConfirm agar pakai makeConfirmUrl */
(function(){
  const _oldAuto = window.__autoConfirmOnce;
  window.__autoConfirmOnce = async function(){
    let oid = null;
    try{
      const q = new URLSearchParams(location.search);
      const fromUrl = q.get("order_id") || q.get("orderId") || q.get("order");
      if(fromUrl){ localStorage.setItem("lastOrderId", fromUrl); }
      oid = localStorage.getItem("lastOrderId");
    }catch(_){}
    if(!oid) return;

    try{
      const r = await fetch(makeConfirmUrl(oid));
      const t = await r.text(); let j=null; try{ j=JSON.parse(t);}catch{}
      console.log("[autoConfirmX]", r.status, j||t);
      if(r.ok && j && j.success){
        localStorage.removeItem("lastOrderId");
        location.replace(location.pathname);
      }
    }catch(e){ console.warn("[autoConfirmX] err", e); }
  };
  // jalankan segera setelah DOM ready
  document.addEventListener("DOMContentLoaded", ()=> setTimeout(()=>window.__autoConfirmOnce(), 500));
})();
