# StorageAudit Pro 🚀
**Sistem Audit Penyimpanan Rekursif & Pembersih Duplikat In-Place**

Aplikasi utilitas audit dan pembersih penyimpanan modern berbasis Node.js native tanpa dependensi eksternal (`npm install` tidak diperlukan). Dilengkapi Web UI responsif, interaktif, dan modern di `http://localhost:3000`.

---

## 📌 Fitur Utama & Kepatuhan SRS

1. **Input Path Folder Dinamis di Web UI**
   - Default target: `./Bahan Latihan P12` (tidak di-hardcode).
   - Pengguna dapat mengetikkan atau memilih path folder lokal mana pun secara dinamis langsung dari antarmuka Web UI.
   - Pemindaian rekursif mengumpulkan nama file, path absolut, path relatif, ukuran byte, dan kalkulasi hash **SHA-256** tiap file ke memori.

2. **Pengelompokan File Duplikat (SHA-256 Identik)**
   - Mendeteksi dan mengelompokkan file yang memiliki konten persis sama meskipun nama filenya berbeda (misal `modul.pdf` dan `modul_BACKUP.pdf`).
   - Pada folder bahan latihan (`./Bahan Latihan P12`), terdapat **20 kelompok duplikat** (masing-masing 2+ file).

3. **Deteksi File Raksasa (&ge; 2 MB / 2.048 KB)**
   - Menandai file yang ukurannya &ge; 2.048 KB (2.097.152 bytes).
   - Menampilkan daftar **15 file raksasa** terurut dari yang terbesar beserta ukuran dalam format MB dan KB.

4. **Dashboard Responsif & Visualisasi Metrik**
   - 4 Kartu Metrik Storage:
     - **Total File** (64 file)
     - **Total Kapasitas** (61,41 MB)
     - **File Raksasa** (15 file)
     - **Potensi Hemat** (18,00 MB)
   - Tabel File Raksasa dengan fitur pencarian/filter cepat.
   - Accordion Kelompok Duplikat dengan toggle expand/collapse, preview hash SHA-256, dan badge pembeda:
     - 🟢 `ASLI (DIPERTAHANKAN)`
     - 🔴 `SALINAN KEMBAR (AKAN DIHAPUS)`

5. **Pembersihan Langsung di Tempat (In-Place Execution)**
   - Tombol **"Bersihkan Duplikat & Sampah"** dengan modal konfirmasi interaktif.
   - Hanya menghapus salinan kembar dan file `.tmp`, serta **wajib mempertahankan 1 file asli per grup**.
   - Berdampak langsung ke folder target (kapasitas folder asal langsung berkurang tanpa membuat folder salinan baru).

6. **Arsitektur File Tunggal Native**
   - Dibangun dengan Node.js bawaan menggunakan modul native: `http`, `fs`, `path`, `crypto`, `child_process`.
   - Otomatis membuka browser saat server dijalankan.
   - Tersedia juga versi alternatif Python `storage_audit.py` menggunakan standard library (`http.server`, `os`, `hashlib`, `webbrowser`).

---

## 💻 Cara Menjalankan

### Opsi 1: Node.js (Rekomendasi Utama)
```bash
node storage_audit.js
```
*Aplikasi akan langsung membuka browser di `http://localhost:3000`.*

### Opsi 2: Python (Jika Python terpasang)
```bash
python storage_audit.py
```

---

## 🧪 Hasil Verifikasi Bahan Latihan P12
- **Total File Dipindai**: 64 File
- **Total Kapasitas Awal**: 61,41 MB (64.395.412 Bytes)
- **File Raksasa (&ge; 2 MB)**: 15 File
- **Kelompok Duplikat**: 20 Grup
- **Salinan Redundan**: 21 File
- **Potensi Penghematan Kapasitas**: 18,00 MB
- **Total File Setelah Dibersihkan**: 43 File (Semua duplikat tuntas dibersihkan)