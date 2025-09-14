# Wed-System — Catatan Proyek (14 Sep 2025, 00:30 WIB)

Sistem manajemen vendor wedding (Pricelist, Add-on, Kode Diskon, Bundling, Vendor Profile, pembayaran berlangganan).

---

## Ringkasan Status

**Hosting (Firebase Hosting)**
- URL: `https://wedsystem25.web.app`
- Routing:
  - `/` → Landing Page
  - `/auth.html` → Login / Daftar / Lupa Password
  - `/dashboardvendor` → Dashboard Vendor (setelah login)

**Auth**
- Email/Password aktif, pengguna lama di Firebase Authentication tetap bisa login.
- Redirect login → `/dashboardvendor`.

**Dashboard Vendor**
- **Status langganan**: `trial/pro/expired` + countdown (otomatis dari `expiresAt`).
- **Profil Vendor**: form edit sederhana (brand, WA, alamat, kota, bank).
- **Pricelist**: kategori `wedding / lamaran / prewedding`, urut harga, tambah/edit/hapus.
- **Add-on**: urut harga, tambah/edit/hapus.
- **Kode Diskon**: tipe `percent/amount`, scope `all/selected packages`, stackable, aktif/nonaktif, tambah/edit/hapus.
- **Bundling**: pilih paket, diskon persen, aktif/nonaktif, tambah/edit/hapus.
- Tombol **Keluar** berfungsi, kembali ke `/auth.html`.

**Pembayaran Berlangganan**
- Saat ini **Payment Link Midtrans (Sandbox)** (manual redirect ke halaman pembayaran).
- Setelah pembayaran, **perpanjangan +30 hari belum otomatis** (plan masih manual).
- Tersedia endpoint dev untuk set plan (sementara) agar testing bisa lanjut.

---

## Arsitektur Data (Firestore)

Dokumen vendor bisa berada di salah satu koleksi lama:
- `vendors/{uid}` **atau** `vendor/{uid}`

Aplikasi otomatis memilih sumber paling lengkap.
Subkoleksi:
- `packages` (pricelist)
- `addons`
- `discounts`
- `bundles`

> Catatan: Hindari duplikasi data di `vendors/` vs `vendor/`. Ke depan disarankan **migrasi ke satu koleksi (`vendors/`)** saja.

---

## Yang Sudah Berjalan

- Landing page rapi menjelaskan **Pricelist Interaktif** + CTA.
- Auth: Login/Daftar/Reset Password, halaman terpisah, responsif.
- Dashboard Vendor:
  - Tampilkan status plan + countdown.
  - **CRUD**: Profil, Pricelist, Add-on, Kode Diskon, Bundling (tambah/edit/hapus).
  - Urutan dan filter (Pricelist by kategori; Add-on by harga).
- Debug bar (UID, Doc Source) **disembunyikan** agar tampilan bersih.

---

## Kendala & Catatan Teknis

1. **Status Vendor (trial/pro/expired)**
   - Sudah tampil; **expiry otomatis** mengunci aksi edit (read-only) saat expired.
   - Efek `expired`: tombol tambah/edit/hapus dinonaktifkan (view tetap jalan).

2. **Duplikasi Data**
   - Gejala: item muncul ganda setelah refresh.
   - Penyebab: data terbaca dari dua koleksi (`vendors/` dan `vendor/`) atau double write.
   - Penanganan sementara:
     - App memilih koleksi dengan skor data lebih lengkap.
     - Tidak melakukan double-write saat CRUD.
   - Tindak lanjut: **migrasi & deduplikasi** → konsolidasi ke `vendors/` (lihat rencana).

3. **Pembayaran Midtrans**
   - Saat ini **Payment Link (sandbox)** → manual.
   - Auto perpanjang +30 hari **belum** (butuh **server endpoint**/Cloud Functions untuk verifikasi notifikasi Midtrans dan update `expiresAt`).
   - Endpoint `notify` sempat `Bad Signature` (akan diperbaiki saat pindah ke Snap/HTTPs Cloud Functions + validasi signature).

4. **Rules Firestore**
   - Sudah diperbaiki dari error kompiler.
   - Masih **development**; perlu pengetatan (scoped per-user).

5. **Cache Browser**
   - Di desktop kadang UI kosong akibat cache. Jika blank, lakukan **Hard Reload** / bersihkan cache untuk domain.

---

## Cara Pakai (Developer)

### Deploy Hosting
```powershell
cd E:\WEDSYSTEMBACKUP\wedsystem
firebase deploy --only "hosting" -P wedsystem25
