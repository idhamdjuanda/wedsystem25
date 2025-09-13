/* vendor.js v47 - status, lock expired, dedupe, anti double-load */
(function(){
  "use strict";

  // ===== Guard: jangan load 2x =====
  if (window.__WEDSYS_VENDOR_LOADED) { throw new Error("vendor.js loaded twice"); }
  window.__WEDSYS_VENDOR_LOADED = true;

  // ===== Mini helpers =====
  const $  = (q, el=document) => el.querySelector(q);
  const $$ = (q, el=document) => Array.from(el.querySelectorAll(q));
  function fmtRp(n){ try { return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(n)||0); } catch { return "Rp"+n; } }
  function fmtMs(ms){
    if(!ms || ms<=0) return "—";
    const s = Math.floor(ms/1000);
    const d = Math.floor(s/86400);
    const h = Math.floor((s%86400)/3600);
    const m = Math.floor((s%3600)/60);
    const ss= s%60;
    return d+" hari "+h+" jam "+m+" menit "+ss+" detik";
  }
  function normPrice(v){ const n = typeof v==="string" ? v.replace(/[^\d]/g,"") : v; const nn = Number(n); return Number.isFinite(nn)? nn : 0; }
  function readField(obj, names, fallback){
    for(const k of names){
      const v = obj && obj[k];
      if(v===0) return 0;
      if(v!==undefined && v!==null){
        if(typeof v==="string"){ const s=v.trim(); if(s) return s; }
        else if(typeof v==="number" && Number.isFinite(v)) return v;
        else if(typeof v==="object" && Object.keys(v).length>0) return v;
      }
    }
    return (fallback===undefined? "": fallback);
  }
  function dedupeByKey(items, keyFn){
    const seen = new Set(); const out = [];
    for(const it of items){ const k = keyFn(it); if(seen.has(k)) continue; seen.add(k); out.push(it); }
    return out;
  }
  function setText(elm, msg, ok){
    if(!elm) return;
    elm.textContent = msg;
    if(ok===true){ elm.classList.add("text-emerald-400"); elm.classList.remove("text-amber-300"); }
    else if(ok===false){ elm.classList.add("text-amber-300"); elm.classList.remove("text-emerald-400"); }
  }

  // ===== Firebase bridges (dari vendor-boot.js via window) =====
  let auth, db, onAuthStateChanged, signOut, serverTimestamp, doc, setDoc, getDoc, collection, getDocs, deleteDoc;
  function requireFirebase(){
    if(!window.__firebaseReady) throw new Error("Firebase belum siap");
    auth = window.auth; db = window.db;
    onAuthStateChanged = window.onAuthStateChanged; signOut = window.signOut;
    serverTimestamp = window.serverTimestamp;
    doc = window.doc; setDoc = window.setDoc; getDoc = window.getDoc;
    collection = window.collection; getDocs = window.getDocs; deleteDoc = window.deleteDoc;
  }

  // ===== Elements =====
  const el = {
    planText: $("#planText"),
    countdown: $("#countdown"),
    profileInfo: $("#profileInfo"),
    inputs: {
      brand: $("#fBrand"), wa: $("#fWa"), addr: $("#fAddr"), city: $("#fCity"),
      bankName: $("#fBankName"), bankNo: $("#fBankNo"), bankHolder: $("#fBankHolder")
    },
    saveBtn: $("#btnSaveProfile"), saveInfo: $("#saveInfo"),
    btnPay: $("#btnPay"), btnRefreshPay: $("#btnRefreshPay"), btnLogout: $("#btnLogout"),
    // Pricelist
    plType: $("#plType"), plName: $("#plName"), plDetail: $("#plDetail"), plPrice: $("#plPrice"),
    plAdd: $("#plAdd"), plInfo: $("#plInfo"), plList: $("#plList"),
    // Add-on
    adName: $("#adName"), adPrice: $("#adPrice"), adAdd: $("#adAdd"), adInfo: $("#adInfo"), adList: $("#adList"),
    // Discount
    dcCode: $("#dcCode"), dcType: $("#dcType"), dcValue: $("#dcValue"),
    dcScope: $("#dcScope"), dcPkgWrap: $("#dcPkgWrap"), dcPkgList: $("#dcPkgList"),
    dcActive: $("#dcActive"), dcStack: $("#dcStack"), dcAdd: $("#dcAdd"),
    dcInfo: $("#dcInfo"), dcList: $("#dcList"),
    // Bundling
    bdName: $("#bdName"), bdPct: $("#bdPct"), bdActive: $("#bdActive"),
    bdPkgList: $("#bdPkgList"), bdAdd: $("#bdAdd"), bdInfo: $("#bdInfo"), bdList: $("#bdList"),
    // debug
    docSource: $("#docSource")
  };

  // ===== State =====
  let currentUser = null;
  let primary = null;     // "vendors/<uid>" atau "vendor/<uid>"
  let alternate = null;
  let countdownTimer = null;
  let pkgCache = [];
  let pkgById = new Map();
  let currentPlan = "trial";
  let currentExpiresAt = 0;
  const editing = { pkg:null, addon:null, disc:null, bundle:null };

  function splitPath(p){ const parts = (p||"").split("/"); return {col:parts[0]||"", uid:parts[1]||""}; }
  function setPrimary(p){
    primary = p;
    const parts = splitPath(p);
    alternate = (parts.col==="vendors") ? ("vendor/"+parts.uid) : ("vendors/"+parts.uid);
    if(el.docSource) el.docSource.textContent = primary;
  }
  function hideDebugBars(){
    try{
      const sel = ["#docSource", "[data-debug]", ".debug", ".doc-source-row"];
      sel.forEach(s=> document.querySelectorAll(s).forEach(n=>{
        const row = n.closest(".p-2, .p-3, .flex, .grid, div") || n;
        row.style.display = "none";
      }));
      Array.from(document.querySelectorAll("div,p,span,small")).forEach(x=>{
        const t=(x.textContent||"").trim(); if(/^Doc Source:/i.test(t)) x.style.display="none";
      });
    }catch(e){}
  }

  // ===== Plan & countdown =====
  function renderPlan(plan, expiresAt){
    if(el.planText) el.planText.textContent = (plan? String(plan).toUpperCase() : "—");
    clearInterval(countdownTimer);
    if(expiresAt && expiresAt>0){
      const tick = function(){
        const rest = expiresAt - Date.now();
        if(el.countdown) el.countdown.textContent = rest>0 ? fmtMs(rest) : "—";
      };
      tick(); countdownTimer = setInterval(tick, 1000);
    } else {
      if(el.countdown) el.countdown.textContent = "—";
    }
    currentPlan = plan || "trial";
    currentExpiresAt = expiresAt || 0;
    applyPlanLock();
  }

  function applyPlanLock(){
    const now = Date.now();
    const expired = currentExpiresAt && (now >= currentExpiresAt);
    const statusText = expired ? "EXPIRED" : (currentPlan==="pro" ? "PRO" : "TRIAL");
    if(el.planText) el.planText.textContent = statusText;

    // Lock CRUD jika expired (profil & bayar tetap aktif)
    const lock = !!expired;
    const editableSelectors = [
      "#panel-pricelist input, #panel-pricelist textarea, #panel-pricelist button",
      "#panel-addon input, #panel-addon button",
      "#panel-discount input, #panel-discount select, #panel-discount button",
      "#panel-bundle input, #panel-bundle button, #panel-bundle select"
    ];
    editableSelectors.forEach(function(sel){
      Array.from(document.querySelectorAll(sel)).forEach(function(n){
        n.disabled = lock;
        if(n.classList) {
          n.classList.toggle("opacity-50", lock);
          n.classList.toggle("pointer-events-none", lock);
        }
      });
    });
    if(lock && el.profileInfo){ el.profileInfo.textContent = "Langganan kedaluwarsa. Silakan perpanjang untuk mengedit data."; }
  }

  // ===== Sumber data: pilih vendors atau vendor =====
  async function pickBestSource(uid){
    const cols = ["vendors","vendor"];
    const snaps = await Promise.all(cols.map(function(c){ return getDoc(doc(db, c, uid)).catch(function(){ return null; }); }));
    const exists = snaps.map(function(s){ return !!(s && s.exists()); });
    const paths = cols.map(function(c,i){ return exists[i] ? (c+"/"+uid) : null; }).filter(Boolean);
    if(paths.length===0){
      await setDoc(doc(db,"vendors",uid), { uid:uid, createdAt: serverTimestamp(), plan:"trial", status:"aktif" }, {merge:true});
      setPrimary("vendors/"+uid);
      return;
    }
    if(paths.length===1){ setPrimary(paths[0]); return; }

    const dA = (snaps[0] && snaps[0].data()) || {};
    const dB = (snaps[1] && snaps[1].data()) || {};
    function scoreBase(d){ return (d.brand||d.brandName||d.vendorName?3:0) + (d.whatsapp?2:0) + (d.address?1:0); }
    async function countPk(path){
      const parts = splitPath(path);
      try{ const s = await getDocs(collection(db, parts.col, parts.uid, "packages")); return s.size||0; } catch{ return 0; }
    }
    const cntA = await countPk("vendors/"+uid);
    const cntB = await countPk("vendor/"+uid);
    const scoreA = scoreBase(dA) + (cntA?5:0);
    const scoreB = scoreBase(dB) + (cntB?5:0);
    if(scoreA===scoreB){
      if(cntA>cntB) setPrimary("vendors/"+uid);
      else if(cntB>cntA) setPrimary("vendor/"+uid);
      else setPrimary("vendor/"+uid);
    } else {
      setPrimary( scoreA>scoreB ? ("vendors/"+uid) : ("vendor/"+uid) );
    }
  }

  // ===== Profil =====
  async function loadProfile(){
    const parts = splitPath(primary);
    const s = await getDoc(doc(db, parts.col, parts.uid));
    const data = (s && s.data()) || {};

    if(el.inputs.brand)      el.inputs.brand.value      = data.brand || data.brandName || data.vendorName || "";
    if(el.inputs.wa)         el.inputs.wa.value         = data.whatsapp || "";
    if(el.inputs.addr)       el.inputs.addr.value       = data.address || "";
    if(el.inputs.city)       el.inputs.city.value       = data.city || "";
    if(el.inputs.bankName)   el.inputs.bankName.value   = data.bankName || "";
    if(el.inputs.bankNo)     el.inputs.bankNo.value     = data.bankNo || data.bankNumber || "";
    if(el.inputs.bankHolder) el.inputs.bankHolder.value = data.bankHolder || "";

    var expiresAt = 0;
    if(typeof data.expiresAt==="number") expiresAt = data.expiresAt;
    else if(data.expiresAt && data.expiresAt._seconds) expiresAt = data.expiresAt._seconds*1000;
    else if(data.expiresAt && data.expiresAt.seconds)  expiresAt = data.expiresAt.seconds*1000;
    else if(data.trialEndsAt && data.trialEndsAt._seconds) expiresAt = data.trialEndsAt._seconds*1000;
    else if(data.trialEndsAt && data.trialEndsAt.seconds)  expiresAt = data.trialEndsAt.seconds*1000;

    renderPlan(data.plan || "trial", expiresAt);
    setText(el.profileInfo, "Profil dimuat.", true);
  }
  async function saveProfile(){
    const d = {
      brand: (el.inputs.brand && el.inputs.brand.value.trim()) || "",
      whatsapp: (el.inputs.wa && el.inputs.wa.value.trim()) || "",
      address: (el.inputs.addr && el.inputs.addr.value.trim()) || "",
      city: (el.inputs.city && el.inputs.city.value.trim()) || "",
      bankName: (el.inputs.bankName && el.inputs.bankName.value.trim()) || "",
      bankNo: (el.inputs.bankNo && el.inputs.bankNo.value.trim()) || "",
      bankHolder: (el.inputs.bankHolder && el.inputs.bankHolder.value.trim()) || "",
      updatedAt: serverTimestamp()
    };
    try{
      const parts = splitPath(primary);
      await setDoc(doc(db, parts.col, parts.uid), d, {merge:true});
      if(el.saveInfo) el.saveInfo.textContent = "Tersimpan.";
    }catch(e){
      if(el.saveInfo) el.saveInfo.textContent = "Gagal simpan: " + e.message;
    }
  }

  // ===== Pricelist =====
  async function loadAllPackagesTry(path){
    const parts = splitPath(path);
    const snap = await getDocs(collection(db, parts.col, parts.uid, "packages"));
    const arr = [];
    pkgById.clear();
    snap.forEach(function(d){
      const x = d.data() || {};
      const type  = readField(x, ["type","jenis","jenisAcara","category","kategori"], "wedding");
      const name  = readField(x, ["name","nama","title","label","paketName","namaPaket","paket","judul"], "");
      const detail= readField(x, ["detail","deskripsi","desc","keterangan","notes","detailPaket","rincian"], "");
      const price = readField(x, ["price","harga","amount","nominal","hargaPaket","hargaBaru"], 0);
      const it = { id:d.id, type:type, name:name, detail:detail, price: normPrice(price) };
      arr.push(it); pkgById.set(d.id, it);
    });
    arr.sort(function(a,b){ return (a.type||"").localeCompare(b.type||"") || (a.price-b.price) || (a.name||"").localeCompare(b.name||""); });
    return arr;
  }
  async function ensureRightSourceForPackages(){
    let list = await loadAllPackagesTry(primary);
    if(list.length===0 && alternate){
      const altList = await loadAllPackagesTry(alternate);
      if(altList.length>0){ setPrimary(alternate); list = altList; }
    }
    pkgCache = list;
  }
  function renderPackageItem(item){
    const nama   = item.name && String(item.name).trim().length ? item.name : "(tanpa nama)";
    const detail = (item.detail || "").toString().replace(/\s*\n\s*/g, "\n");
    const wrap = document.createElement("div");
    wrap.className = "flex items-start gap-3 p-3 bg-slate-900/50";
    wrap.innerHTML = [
      '<div class="flex-1 whitespace-pre-wrap">',
        '<div class="font-medium">', nama, '</div>',
        (detail ? '<div class="text-sm opacity-70">'+detail+'</div>' : ''),
        '<div class="text-emerald-400 mt-1">', fmtRp(item.price||0), '</div>',
        '<div class="text-xs opacity-60 mt-1">', (item.type||"wedding"), '</div>',
      '</div>',
      '<div class="flex items-center gap-2">',
        '<button class="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm btn-edit">Edit</button>',
        '<button class="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-sm btn-del">Hapus</button>',
      '</div>'
    ].join("");
    wrap.querySelector(".btn-del").addEventListener("click", async function(){
      if(!confirm("Hapus paket ini?")) return;
      const p = splitPath(primary);
      await deleteDoc(doc(db, p.col, p.uid, "packages", item.id));
      await refreshPricelist();
    });
    wrap.querySelector(".btn-edit").addEventListener("click", function(){
      if(el.plType) el.plType.value   = item.type || "wedding";
      if(el.plName) el.plName.value   = item.name || "";
      if(el.plDetail) el.plDetail.value = item.detail || "";
      if(el.plPrice) el.plPrice.value  = item.price || "";
      editing.pkg = item.id;
      if(el.plAdd) el.plAdd.textContent = "Simpan Perubahan";
    });
    return wrap;
  }
  async function refreshPricelist(){
    const type = (el.plType && el.plType.value) || "wedding";
    if(el.plInfo) el.plInfo.textContent = "Memuat…";
    if(el.plList) el.plList.innerHTML = "";
    try{
      await ensureRightSourceForPackages();
      let items = pkgCache.filter(function(p){ return (p.type===type); });
      items = dedupeByKey(items, function(it){ return (it.type||"").toLowerCase()+"|"+(it.name||"").toLowerCase()+"|"+(it.price||0); });
      if(!items.length){ if(el.plInfo) el.plInfo.textContent = "Belum ada paket."; return; }
      if(el.plInfo) el.plInfo.textContent = String(items.length)+" paket ("+type+")";
      items.forEach(function(it){ el.plList.appendChild(renderPackageItem(it)); });
    }catch(e){
      if(el.plInfo) el.plInfo.textContent = "Gagal memuat: " + e.message;
    }
  }
  async function addOrUpdatePackage(){
    const name = (el.plName && el.plName.value.trim()) || "";
    const detail = (el.plDetail && el.plDetail.value.trim()) || "";
    const price = normPrice(el.plPrice && el.plPrice.value);
    const type  = (el.plType && el.plType.value) || "wedding";
    if(!name || !price){ alert("Isi nama dan harga paket."); return; }
    const p = splitPath(primary);
    const id = editing.pkg || ("p_"+Date.now());
    await setDoc(doc(db, p.col, p.uid, "packages", id), {
      type:type, name:name, detail:detail, price:price, updatedAt: serverTimestamp()
    }, {merge:true});
    if(el.plName) el.plName.value="";
    if(el.plDetail) el.plDetail.value="";
    if(el.plPrice) el.plPrice.value="";
    editing.pkg=null; if(el.plAdd) el.plAdd.textContent="Tambahkan";
    await refreshPricelist();
  }

  // ===== Add-on =====
  function renderAddonItem(it){
    const wrap = document.createElement("div");
    wrap.className="flex items-center justify-between p-3 bg-slate-900/50";
    wrap.innerHTML=[
      '<div>',
        '<div class="font-medium">', (it.name||"-"), '</div>',
        '<div class="text-emerald-400 mt-1">', fmtRp(it.price||0), '</div>',
      '</div>',
      '<div class="flex items-center gap-2">',
        '<button class="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm btn-edit">Edit</button>',
        '<button class="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-sm btn-del">Hapus</button>',
      '</div>'
    ].join("");
    wrap.querySelector(".btn-del").addEventListener("click", async function(){
      if(!confirm("Hapus add-on ini?")) return;
      const p = splitPath(primary);
      await deleteDoc(doc(db, p.col, p.uid, "addons", it.__id));
      await refreshAddon();
    });
    wrap.querySelector(".btn-edit").addEventListener("click", function(){
      if(el.adName) el.adName.value = it.name || "";
      if(el.adPrice) el.adPrice.value = it.price || "";
      editing.addon = it.__id;
      if(el.adAdd) el.adAdd.textContent = "Simpan Perubahan";
    });
    return wrap;
  }
  async function refreshAddon(){
    if(el.adInfo) el.adInfo.textContent="Memuat…";
    if(el.adList) el.adList.innerHTML="";
    async function readFrom(path){
      const p = splitPath(path);
      const snap = await getDocs(collection(db, p.col, p.uid, "addons"));
      const items = [];
      snap.forEach(function(d){
        const x = d.data()||{};
        items.push({ __id:d.id, name:x.name || x.nama || "", price:normPrice(x.price || x.harga || 0) });
      });
      items.sort(function(a,b){ return a.price - b.price; });
      return items;
    }
    try{
      let items = await readFrom(primary);
      if(items.length===0 && alternate){
        const alt = await readFrom(alternate);
        if(alt.length>0){ setPrimary(alternate); items = alt; }
      }
      items = dedupeByKey(items, function(it){ return (it.name||"").toLowerCase()+"|"+(it.price||0); });
      if(!items.length){ if(el.adInfo) el.adInfo.textContent="Belum ada add-on."; return; }
      if(el.adInfo) el.adInfo.textContent= String(items.length)+" add-on";
      items.forEach(function(it){ el.adList.appendChild(renderAddonItem(it)); });
    }catch(e){ if(el.adInfo) el.adInfo.textContent="Gagal memuat: "+e.message; }
  }
  async function addOrUpdateAddon(){
    const name = (el.adName && el.adName.value.trim()) || "";
    const price = normPrice(el.adPrice && el.adPrice.value);
    if(!name || !price){ alert("Isi nama dan harga add-on."); return; }
    const p = splitPath(primary);
    const id = editing.addon || ("a_"+Date.now());
    await setDoc(doc(db, p.col, p.uid, "addons", id), {
      name:name, price:price, updatedAt: serverTimestamp()
    }, {merge:true});
    if(el.adName) el.adName.value="";
    if(el.adPrice) el.adPrice.value="";
    editing.addon=null; if(el.adAdd) el.adAdd.textContent="Tambahkan";
    await refreshAddon();
  }

  // ===== Discount =====
  function toggleDiscountScope(){ if(el.dcPkgWrap) el.dcPkgWrap.style.display = (el.dcScope && el.dcScope.value==="selected") ? "" : "none"; }
  function renderPkgCheckboxes(container, selected){
    if(!container) return;
    container.innerHTML = "";
    const sel = new Set(Array.isArray(selected)? selected : []);
    pkgCache.forEach(function(p){
      const id = "pkg_"+p.id;
      const wrap = document.createElement("label");
      wrap.className = "flex items-center gap-2 bg-slate-900/50 rounded-lg px-3 py-2";
      wrap.innerHTML = [
        '<input type="checkbox" class="accent-emerald-500" id="',id,'" value="',p.id,'" ', (sel.has(p.id)?'checked':''), '>',
        '<span class="flex-1">',
          '<span class="font-medium">', (p.name||"-"), '</span> ',
          '<span class="opacity-60 text-sm">(', (p.type||""), ')</span>',
          '<span class="block text-emerald-400">', fmtRp(p.price||0), '</span>',
        '</span>'
      ].join("");
      container.appendChild(wrap);
    });
  }
  function renderDiscountItem(it){
    const scopeTxt = (it.scope && it.scope.type==="selected") ? ("Paket terpilih ("+((it.scope.packageIds||[]).length)+")") : "Semua paket";
    const valueTxt = (it.type==="percent") ? (String(Number(it.value||0))+"%") : fmtRp(it.value||0);
    const wrap = document.createElement("div");
    wrap.className="p-3 bg-slate-900/50";
    wrap.innerHTML=[
      '<div class="flex items-start gap-3">',
        '<div class="flex-1">',
          '<div class="font-semibold">', (it.code||"-"), '</div>',
          '<div class="text-sm opacity-70">', scopeTxt, ' • ', (it.stackable?'Stackable':'Single'), ' • ', (it.active?'Aktif':'Nonaktif'), '</div>',
          '<div class="text-emerald-400 mt-1">', valueTxt, '</div>',
        '</div>',
        '<div class="flex items-center gap-2">',
          '<button class="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm btn-edit">Edit</button>',
          '<button class="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-sm btn-del">Hapus</button>',
        '</div>',
      '</div>'
    ].join("");
    wrap.querySelector(".btn-del").addEventListener("click", async function(){
      if(!confirm("Hapus kode diskon ini?")) return;
      const p = splitPath(primary);
      await deleteDoc(doc(db, p.col, p.uid, "discounts", it.__id));
      await refreshDiscounts();
    });
    wrap.querySelector(".btn-edit").addEventListener("click", function(){
      if(el.dcCode) el.dcCode.value = it.code||"";
      if(el.dcType) el.dcType.value = it.type||"percent";
      if(el.dcValue) el.dcValue.value= Number(it.value||0);
      if(el.dcActive) el.dcActive.checked = !!it.active;
      if(el.dcStack)  el.dcStack.checked  = !!it.stackable;
      if(el.dcScope){ el.dcScope.value = (it.scope && it.scope.type==="selected") ? "selected" : "all"; }
      toggleDiscountScope();
      renderPkgCheckboxes(el.dcPkgList, (it.scope && it.scope.packageIds)||[]);
      editing.disc = it.__id;
      if(el.dcAdd) el.dcAdd.textContent = "Simpan Perubahan";
    });
    return wrap;
  }
  async function refreshDiscounts(){
    if(el.dcInfo) el.dcInfo.textContent="Memuat…";
    if(el.dcList) el.dcList.innerHTML="";
    try{
      const p = splitPath(primary);
      const snap = await getDocs(collection(db, p.col, p.uid, "discounts"));
      let items = [];
      snap.forEach(function(d){
        const x = d.data()||{};
        items.push({
          __id:d.id, code:(x.code||""), type:(x.type||"percent"),
          value:Number(x.value||0), scope:x.scope||{type:"all",packageIds:[]},
          active:!!x.active, stackable:!!x.stackable
        });
      });
      items.sort(function(a,b){ return (a.code||"").localeCompare(b.code||""); });
      items = dedupeByKey(items, function(it){ return (it.code||"").toLowerCase(); });
      if(!items.length){ if(el.dcInfo) el.dcInfo.textContent="Belum ada kode diskon."; return; }
      if(el.dcInfo) el.dcInfo.textContent= String(items.length)+" kode diskon";
      items.forEach(function(it){ el.dcList.appendChild(renderDiscountItem(it)); });
    }catch(e){ if(el.dcInfo) el.dcInfo.textContent="Gagal memuat: "+e.message; }
  }
  async function addOrUpdateDiscount(){
    const code = (el.dcCode && el.dcCode.value.trim()) || "";
    const type = (el.dcType && el.dcType.value) || "percent";
    let value = Number(String((el.dcValue && el.dcValue.value) || "").replace(/[^\d]/g,""));
    if(!code){ alert("Isi kode."); return; }
    if(type==="percent" && (value<1 || value>100)){ alert("Persentase 1–100."); return; }
    if(type==="amount"  && (value<1)){ alert("Nominal minimal 1."); return; }

    const scopeType = (el.dcScope && el.dcScope.value) || "all";
    let packageIds = [];
    if(scopeType==="selected"){
      packageIds = Array.from((el.dcPkgList && el.dcPkgList.querySelectorAll('input[type="checkbox"]:checked')) || []).map(function(i){ return i.value; });
      if(packageIds.length===0){ alert("Pilih paket untuk scope terpilih."); return; }
    }
    const p = splitPath(primary);
    const id = editing.disc || ("d_"+Date.now());
    await setDoc(doc(db, p.col, p.uid, "discounts", id), {
      code:code, type:type, value:value, scope:{type:scopeType, packageIds:packageIds},
      stackable: !!(el.dcStack && el.dcStack.checked), active: !!(el.dcActive && el.dcActive.checked),
      updatedAt: serverTimestamp()
    }, {merge:true});

    if(el.dcCode) el.dcCode.value="";
    if(el.dcValue) el.dcValue.value="";
    if(el.dcScope) el.dcScope.value="all";
    toggleDiscountScope(); renderPkgCheckboxes(el.dcPkgList, []);
    editing.disc=null; if(el.dcAdd) el.dcAdd.textContent="Tambahkan";
    await refreshDiscounts();
  }

  // ===== Bundling =====
  function renderBundleItem(it){
    const names=(it.packageIds||[]).map(function(id){ return (pkgById.get(id) && pkgById.get(id).name) || id; });
    const wrap=document.createElement("div");
    wrap.className="p-3 bg-slate-900/50";
    wrap.innerHTML=[
      '<div class="flex items-start gap-3">',
        '<div class="flex-1">',
          '<div class="font-semibold">', (it.name||"-"), '</div>',
          '<div class="text-sm opacity-70">', (it.active?'Aktif':'Nonaktif'), ' • ', (names.length), ' paket</div>',
          '<div class="text-emerald-400 mt-1">Diskon bundling: ', String(Number(it.discountPercent||0)),'%</div>',
          '<div class="text-sm mt-2 opacity-80">', names.slice(0,6).join(", "), (names.length>6?" …":""), '</div>',
        '</div>',
        '<div class="flex items-center gap-2">',
          '<button class="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm btn-edit">Edit</button>',
          '<button class="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-sm btn-del">Hapus</button>',
        '</div>',
      '</div>'
    ].join("");
    wrap.querySelector(".btn-del").addEventListener("click", async function(){
      if(!confirm("Hapus bundling ini?")) return;
      const p = splitPath(primary);
      await deleteDoc(doc(db, p.col, p.uid, "bundles", it.__id));
      await refreshBundles();
    });
    wrap.querySelector(".btn-edit").addEventListener("click", function(){
      if(el.bdName) el.bdName.value = it.name || "";
      if(el.bdPct)  el.bdPct.value  = Number(it.discountPercent||0);
      if(el.bdActive) el.bdActive.checked = !!it.active;
      renderPkgCheckboxes(el.bdPkgList, it.packageIds||[]);
      editing.bundle = it.__id;
      if(el.bdAdd) el.bdAdd.textContent = "Simpan Perubahan";
    });
    return wrap;
  }
  async function refreshBundles(){
    if(el.bdInfo) el.bdInfo.textContent = "Memuat…";
    if(el.bdList) el.bdList.innerHTML = "";
    try{
      const p = splitPath(primary);
      const snap = await getDocs(collection(db, p.col, p.uid, "bundles"));
      let items=[];
      snap.forEach(function(d){
        const x = d.data()||{};
        items.push({ __id:d.id, name:(x.name||""), discountPercent:Number(x.discountPercent||0), active:!!x.active, packageIds:(Array.isArray(x.packageIds)?x.packageIds:[]) });
      });
      items.sort(function(a,b){ return (a.name||"").localeCompare(b.name||""); });
      items = dedupeByKey(items, function(it){ 
        var ids = Array.isArray(it.packageIds)? it.packageIds.slice().sort().join(","): "";
        return (it.name||"").toLowerCase()+"|"+ids;
      });
      if(!items.length){ if(el.bdInfo) el.bdInfo.textContent="Belum ada bundling."; return; }
      if(el.bdInfo) el.bdInfo.textContent= String(items.length)+" bundling";
      items.forEach(function(it){ el.bdList.appendChild(renderBundleItem(it)); });
    }catch(e){ if(el.bdInfo) el.bdInfo.textContent="Gagal memuat: "+e.message; }
  }
  async function addOrUpdateBundle(){
    const name = (el.bdName && el.bdName.value.trim()) || "";
    const pct  = Number(String((el.bdPct && el.bdPct.value)||"").replace(/[^\d]/g,""));
    const ids  = Array.from((el.bdPkgList && el.bdPkgList.querySelectorAll('input[type="checkbox"]:checked'))||[]).map(function(i){ return i.value; });
    if(!name){ alert("Isi nama bundling."); return; }
    if(!pct || pct<1 || pct>100){ alert("Diskon 1–100%."); return; }
    if(ids.length<1){ alert("Pilih minimal satu paket."); return; }
    const p = splitPath(primary);
    const id = editing.bundle || ("b_"+Date.now());
    await setDoc(doc(db, p.col, p.uid, "bundles", id), {
      name:name, discountPercent:pct, packageIds:ids, active: !!(el.bdActive && el.bdActive.checked),
      updatedAt: serverTimestamp()
    }, {merge:true});
    if(el.bdName) el.bdName.value="";
    if(el.bdPct)  el.bdPct.value="";
    renderPkgCheckboxes(el.bdPkgList, []);
    editing.bundle=null; if(el.bdAdd) el.bdAdd.textContent="Tambahkan";
    await refreshBundles();
  }

  // ===== Payment link (sementara manual) =====
  var USE_PAYMENT_LINK = true;
  var PAYMENT_LINK_URL = "https://app.sandbox.midtrans.com/payment-links/1757766105450";
  function createPayment(){
    if(USE_PAYMENT_LINK){
      window.open(PAYMENT_LINK_URL, "_blank", "noopener,noreferrer");
      alert("Setelah bayar via Payment Link, kembali ke dashboard lalu perpanjang manual ya. Untuk auto +30 hari, kita aktifkan alur Snap.");
      return;
    }
  }
  async function refreshPayment(){ alert("Payment Link dicek manual. Untuk auto +30 hari, aktifkan alur Snap."); }

  // ===== Tabs & wiring =====
  function showTab(name){
    $$(".tab").forEach(function(b){
      var active = (b.dataset.tab === name);
      b.classList.toggle("bg-emerald-700", active);
      b.classList.toggle("bg-slate-700", !active);
    });
    $$(".panel").forEach(function(p){ p.classList.add("hidden"); });
    var target = $("#panel-"+name); if(target) target.classList.remove("hidden");
  }
  function wireUI(){
    $$(".tab").forEach(function(b){
      b.addEventListener("click", function(){
        var t = b.dataset.tab;
        showTab(t);
        if(t==="pricelist") refreshPricelist();
        if(t==="addon")     refreshAddon();
        if(t==="discount")  { renderPkgCheckboxes(el.dcPkgList); toggleDiscountScope(); refreshDiscounts(); }
        if(t==="bundle")    { renderPkgCheckboxes(el.bdPkgList); refreshBundles(); }
      });
    });
    showTab("profile");

    if(el.saveBtn) el.saveBtn.addEventListener("click", saveProfile);
    if(el.plAdd) el.plAdd.addEventListener("click", addOrUpdatePackage);
    if(el.plType) el.plType.addEventListener("change", refreshPricelist);
    if(el.adAdd) el.adAdd.addEventListener("click", addOrUpdateAddon);
    if(el.dcScope) el.dcScope.addEventListener("change", toggleDiscountScope);
    if(el.dcAdd) el.dcAdd.addEventListener("click", addOrUpdateDiscount);
    if(el.bdAdd) el.bdAdd.addEventListener("click", addOrUpdateBundle);
    if(el.btnPay) el.btnPay.addEventListener("click", createPayment);
    if(el.btnRefreshPay) el.btnRefreshPay.addEventListener("click", refreshPayment);
    if(el.btnLogout) el.btnLogout.addEventListener("click", async function(){ try{ await signOut(auth); }catch(e){} location.href="/auth.html"; });
  }

  // ===== Init =====
  async function initAfterAuth(uid){
    await pickBestSource(uid);
    await loadProfile();
    await ensureRightSourceForPackages();
  }
  function main(){
    try{
      requireFirebase();
      hideDebugBars();
      wireUI();
      onAuthStateChanged(auth, async function(u){
        currentUser = u;
        if(!u){ location.href="/auth.html"; return; }
        setText(el.profileInfo, "Memuat profil…", false);
        try{ await initAfterAuth(u.uid); setText(el.profileInfo, "Profil dimuat.", true); }
        catch(e){ console.error(e); setText(el.profileInfo, "Gagal memuat: "+e.message, false); }
      });
    }catch(e){ console.error("Init error:", e); }
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", main); else main();
})();
