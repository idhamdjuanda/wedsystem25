/**
 * Firebase bootstrap for Wed-System (client)
 * - Exposes app/auth/db & helpers ke window.*
 * - Dispatches "firebase-ready" saat siap
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, serverTimestamp, doc, setDoc, getDoc, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// *** PASTIKAN konfigurasi sesuai project Anda ***
const firebaseConfig = {
  apiKey: "AIzaSyCVNDoM04DtzRda1xMLj6q6FcBLkHbaicE",
  authDomain: "wedsystem25.firebaseapp.com",
  projectId: "wedsystem25",
  storageBucket: "wedsystem25.firebasestorage.app",
  messagingSenderId: "144669260555",
  appId: "1:144669260555:web:6de0fff3c43d46a606400e"
};

// Init
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Ekspos ke window agar file lain bisa akses
Object.assign(window, {
  app, auth, db,
  onAuthStateChanged, signOut,
  serverTimestamp, doc, setDoc, getDoc, collection, getDocs, deleteDoc,
  __firebaseReady: true
});

// Beritahu listener bahwa Firebase siap
window.dispatchEvent(new Event("firebase-ready"));
console.log("[WEDSYS] Firebase ready (client)");
