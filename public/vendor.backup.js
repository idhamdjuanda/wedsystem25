import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, addDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCVNDoM04DtzRda1xMLj6q6FcBLkHbaicE",
  authDomain: "wedsystem25.firebaseapp.com",
  projectId: "wedsystem25",
  storageBucket: "wedsystem25.appspot.com",
  messagingSenderId: "144669260555",
  appId: "1:144669260555:web:6de0fff3c43d46a606400e"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ======== CONFIG =========
const TRIAL_DAYS = 7;
const MONTH_MS   = 30 * 24 * 60 * 60 * 1000;

// ======== UI Helpers ========
const $ = (id)=>document.getElementById(id);
function fmtDDMMYYYY(ms){
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = d.getFullYear();
  return `${dd}${mm}${yy}`;
}
function setBadge(plan){
  const el = $("planBadge");
  el.textContent = plan.toUpperCase();
  el.className = "px-2 py-1 rounded " + (plan==="pro" ? "bg-emerald-600" : plan==="trial" ? "bg-amber-600" : "bg-rose-600");
}
function startCountdown(exp){
  function tick(){
    const now = Date.now();
    const diff = exp - now;
    if(diff <= 0){ $("countdown").textContent = "Expired"; setBadge("expired"); return; }
    const s = Math.floor(diff/1000)%60;
    const m = Math.floor(diff/60000)%60;
    const h = Math.floor(diff/3600000)%24;
    const d = Math.floor(diff/86400000);
    $("countdown").textContent = `Berlaku sampai ${fmtDDMMYYYY(exp)} — ${d} HARI ${h} JAM ${m} MENIT ${s} DETIK`;
  }
  tick(); setInterval(tick, 1000);
}

// ======== Tabs ========
document.querySelectorAll(".tab").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("bg-brand", b===btn));
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("text-slate-900", b===btn));
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("bg-slate-800", b!==btn));
    document.querySelectorAll(".panel").forEach(p=>p.classList.add("hidden"));
    document.getElementById("panel-"+btn.dataset.tab).classList.remove("hidden");
  });
});

// ======== Auth gate ========
onAuthStateChanged(auth, async (u)=>{
  if(!u){ location.href = "/auth.html"; return; }
  $("email").textContent = u.email || u.uid;
  $("logout").onclick = ()=>signOut(auth);

  const vref = doc(db, "vendors", u.uid);
  let snap = await getDoc(vref);
  if(!snap.exists()){
    const exp = Date.now() + TRIAL_DAYS*86400000;
    await setDoc(vref, {
      uid: u.uid,
      email: u.email || null,
      createdAt: serverTimestamp(),
      plan: "trial",
      expiresAt: exp,
      brandName: "", address: "", whatsapp: "", bankName: "", bankNumber: "", bankHolder: ""
    });
    snap = await getDoc(vref);
  }
  const data = snap.data();
  const plan = Date.now() > data.expiresAt ? "expired" : data.plan;
  setBadge(plan); startCountdown(data.expiresAt);

  // Prefill profil
  ["brandName","address","whatsapp","bankName","bankNumber","bankHolder"].forEach(k=>{
    $(k).value = data[k] || "";
  });

  // Simpan profil
  $("formProfil").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await updateDoc(vref, {
      brandName: $("brandName").value.trim(),
      address: $("address").value.trim(),
      whatsapp: $("whatsapp").value.trim(),
      bankName: $("bankName").value.trim(),
      bankNumber: $("bankNumber").value.trim(),
      bankHolder: $("bankHolder").value.trim()
    });
    $("profilMsg").textContent = "Profil tersimpan.";
  });

  // ====== CRUD sederhana: Pricelist ======
  $("formPrice").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await addDoc(collection(db, "vendors", u.uid, "pricelist"), {
      type: $("priceType").value.trim(),
      name: $("priceName").value.trim(),
      detail: $("priceDetail").value.trim(),
      amount: Number($("priceAmount").value||0),
      createdAt: serverTimestamp()
    });
    $("priceType").value = $("priceName").value = $("priceDetail").value = $("priceAmount").value = "";
    loadList("pricelist","priceList");
  });

  $("formAddon").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await addDoc(collection(db, "vendors", u.uid, "addons"), {
      name: $("addonName").value.trim(),
      price: Number($("addonPrice").value||0),
      createdAt: serverTimestamp()
    });
    $("addonName").value = $("addonPrice").value = "";
    loadList("addons","addonList");
  });

  $("formDisc").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await addDoc(collection(db, "vendors", u.uid, "discounts"), {
      code: $("discCode").value.trim(),
      type: $("discType").value,
      value: Number($("discValue").value||0),
      createdAt: serverTimestamp()
    });
    $("discCode").value = $("discValue").value = "";
    loadList("discounts","discList");
  });

  $("formBundle").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await addDoc(collection(db, "vendors", u.uid, "bundles"), {
      name: $("bundleName").value.trim(),
      pct: Number($("bundlePct").value||0),
      items: $("bundleItems").value.trim(),
      createdAt: serverTimestamp()
    });
    $("bundleName").value = $("bundlePct").value = $("bundleItems").value = "";
    loadList("bundles","bundleList");
  });

  async function loadList(colName, listId){
    const q = await getDocs(collection(db, "vendors", u.uid, colName));
    const ul = $(listId); ul.innerHTML = "";
    q.forEach(d=>{
      const li = document.createElement("li");
      li.className = "rounded border border-white/10 p-3";
      li.textContent = JSON.stringify(d.data());
      ul.appendChild(li);
    });
  }
  loadList("pricelist","priceList");
  loadList("addons","addonList");
  loadList("discounts","discList");
  loadList("bundles","bundleList");

  // ====== Payment: panggil Cloud Function ======
  $("btnPay").addEventListener("click", async ()=>{
    $("btnPay").disabled = true; $("btnPay").textContent = "Membuat invoice…";
    try{
      const res = await fetch("/createInvoice", { // akan di-rewrite ke Functions (lihat firebase.json)
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ amount: 50000, uid: (auth.currentUser?.uid||"") })
      });
      const j = await res.json();
      if(j?.paymentUrl){ location.href = j.paymentUrl; }
      else { alert("Gagal membuat invoice"); }
    }catch(e){ alert("Error: "+e.message); }
    $("btnPay").disabled = false; $("btnPay").textContent = "Bayar / Perpanjang 1 bulan (Rp 50.000)";
  });
});


