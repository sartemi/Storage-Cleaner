/**
 * StorageAudit Pro - storage_audit.js
 * Sistem Audit Penyimpanan & Pembersih Duplikat In-Place
 * Dijalankan dengan runtime native Node.js tanpa dependensi npm eksternal.
 * Modul bawaan: http, fs, path, crypto, os, child_process
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const DEFAULT_TARGET_DIR = './Bahan Latihan P12';
const GIANT_THRESHOLD_BYTES = 2048 * 1024; // 2 MB = 2.048 KB = 2,097,152 bytes

// Heuristik untuk mengurutkan file dalam grup duplikat:
// File dengan nama paling bersih/orisinil akan ditempatkan di posisi 0 (ASLI)
function scoreOriginality(filename) {
  let score = 0;
  const lower = filename.toLowerCase();
  if (/\bcopy\b|- copy|_copy|salinan|backup|_backup|edit\d*|\(\d+\)|_v\d+|_final/i.test(lower)) {
    score += 1000;
  }
  // Semakin pendek nama file, biasanya semakin orisinil
  score += filename.length;
  return score;
}

// Rekursif memindai folder dan menghitung metadata
function scanDirectoryRecursively(dirPath, baseDir = dirPath) {
  let results = [];
  if (!fs.existsSync(dirPath)) {
    return results;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    // Abaikan direktori git atau node_modules jika memindai root
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      results = results.concat(scanDirectoryRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      try {
        const stats = fs.statSync(fullPath);
        const fileBuffer = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const relativePath = path.relative(baseDir, fullPath);

        results.push({
          name: entry.name,
          absolutePath: path.resolve(fullPath),
          relativePath: relativePath.replace(/\\/g, '/'),
          sizeBytes: stats.size,
          mtime: stats.mtime,
          hash: hash,
          isTmp: entry.name.toLowerCase().endsWith('.tmp')
        });
      } catch (err) {
        console.error(`Gagal membaca file: ${fullPath}`, err.message);
      }
    }
  }

  return results;
}

// Format MB helper (misal 61.41 MB, 18 MB, 0 B)
function formatNumber(bytes) {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 100) / 100;
  return rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2);
}

function formatMB(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 100) / 100;
  return (rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2)) + ' MB';
}

function formatSavings(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 100) / 100;
  return (rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2)) + ' MB';
}

// Analisis hasil pemindaian
function processAudit(targetFolder) {
  const resolvedTarget = path.resolve(targetFolder);
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`Folder target tidak ditemukan: "${targetFolder}" (Path: ${resolvedTarget})`);
  }

  const allFiles = scanDirectoryRecursively(resolvedTarget, resolvedTarget);

  let totalBytes = 0;
  const hashMap = {};
  const giantFiles = [];
  const tmpFiles = [];

  for (const file of allFiles) {
    totalBytes += file.sizeBytes;

    if (file.isTmp) {
      tmpFiles.push(file);
    }

    // Ambang batas File Raksasa: >= 2 MB (2.048 KB = 2,097,152 bytes)
    if (file.sizeBytes >= GIANT_THRESHOLD_BYTES) {
      const ext = (file.name.split('.').pop() || 'FILE').toUpperCase();
      giantFiles.push({
        name: file.name,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        sizeValue: formatNumber(file.sizeBytes),
        sizeUnit: 'MB',
        sizeFormatted: formatMB(file.sizeBytes),
        sizeKB: (file.sizeBytes / 1024).toFixed(2) + ' KB',
        format: ext,
        hash: file.hash,
        isTmp: file.isTmp
      });
    }

    if (!hashMap[file.hash]) {
      hashMap[file.hash] = [];
    }
    hashMap[file.hash].push(file);
  }

  // Urutkan File Raksasa dari yang terbesar
  giantFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Kelompokkan file duplikat (hash identik, 2+ file)
  const duplicateGroups = [];
  let potentialSavingsBytes = 0;
  let totalRedundantFiles = 0;

  let groupIndex = 1;
  for (const [hash, fileList] of Object.entries(hashMap)) {
    if (fileList.length > 1) {
      // Urutkan file agar file orisinil di index 0
      fileList.sort((a, b) => scoreOriginality(a.name) - scoreOriginality(b.name));

      const singleFileSize = fileList[0].sizeBytes;
      const redundantCount = fileList.length - 1;
      const groupSavings = redundantCount * singleFileSize;
      potentialSavingsBytes += groupSavings;
      totalRedundantFiles += redundantCount;

      duplicateGroups.push({
        groupId: groupIndex++,
        hash: hash,
        shortHash: hash.substring(0, 10) + '...',
        fileCount: fileList.length,
        sizeBytes: singleFileSize,
        totalSizeBytes: fileList.length * singleFileSize,
        sizeMB: formatMB(singleFileSize),
        savingsBytes: groupSavings,
        savingsMB: formatMB(groupSavings),
        files: fileList.map((f, idx) => ({
          name: f.name,
          absolutePath: f.absolutePath,
          relativePath: f.relativePath,
          sizeBytes: f.sizeBytes,
          isOriginal: idx === 0 // 1 file asli per grup dipertahankan
        }))
      });
    }
  }

  // Tambahkan potensi hemat dari file .tmp yang bukan bagian dari duplikat
  for (const tmp of tmpFiles) {
    const inDup = duplicateGroups.some(g => g.files.some(f => f.absolutePath === tmp.absolutePath && !f.isOriginal));
    if (!inDup) {
      potentialSavingsBytes += tmp.sizeBytes;
    }
  }

  return {
    targetFolder: targetFolder,
    resolvedTarget: resolvedTarget,
    totalFiles: allFiles.length,
    totalBytes: totalBytes,
    totalCapacityMB: formatMB(totalBytes),
    giantCount: giantFiles.length,
    giantFiles: giantFiles,
    duplicateGroupCount: duplicateGroups.length,
    duplicateGroups: duplicateGroups,
    tmpCount: tmpFiles.length,
    tmpFiles: tmpFiles.map(t => ({
      name: t.name,
      absolutePath: t.absolutePath,
      relativePath: t.relativePath,
      sizeBytes: t.sizeBytes,
      sizeKB: (t.sizeBytes / 1024).toFixed(2) + ' KB'
    })),
    totalRedundantFiles: totalRedundantFiles,
    potentialSavingsBytes: potentialSavingsBytes,
    potentialSavingsMB: formatSavings(potentialSavingsBytes)
  };
}

// Eksekusi pembersihan in-place
function executeCleanInPlace(targetFolder) {
  const audit = processAudit(targetFolder);
  const deletedFiles = [];
  let freedBytes = 0;
  const errors = [];

  // 1. Hapus salinan kembar (index > 0 pada setiap grup duplikat)
  for (const group of audit.duplicateGroups) {
    for (const file of group.files) {
      if (!file.isOriginal) {
        try {
          if (fs.existsSync(file.absolutePath)) {
            const stat = fs.statSync(file.absolutePath);
            fs.unlinkSync(file.absolutePath);
            freedBytes += stat.size;
            deletedFiles.push({
              name: file.name,
              absolutePath: file.absolutePath,
              type: 'duplikat',
              sizeBytes: stat.size
            });
          }
        } catch (err) {
          errors.push({ file: file.absolutePath, error: err.message });
        }
      }
    }
  }

  // 2. Hapus file sampah .tmp
  for (const tmp of audit.tmpFiles) {
    try {
      if (fs.existsSync(tmp.absolutePath)) {
        const stat = fs.statSync(tmp.absolutePath);
        fs.unlinkSync(tmp.absolutePath);
        freedBytes += stat.size;
        deletedFiles.push({
          name: tmp.name,
          absolutePath: tmp.absolutePath,
          type: 'sampah_tmp',
          sizeBytes: stat.size
        });
      }
    } catch (err) {
      errors.push({ file: tmp.absolutePath, error: err.message });
    }
  }

  // Lakukan audit ulang setelah pembersihan
  const updatedAudit = processAudit(targetFolder);

  return {
    success: true,
    deletedCount: deletedFiles.length,
    deletedFiles: deletedFiles,
    freedBytes: freedBytes,
    freedMB: formatMB(freedBytes),
    errors: errors,
    updatedAudit: updatedAudit
  };
}

// Restore / reset helper dari cadangan lokal
function restoreSampleData(targetFolder) {
  const candidates = [
    'C:/Users/Student/Desktop/Downloads_Lab_BACKUP',
    'C:/Users/Student/Desktop/Downloads_Lab',
    'C:/Users/Student/Downloads/Downloads_Lab',
    path.join(__dirname, 'Bahan Latihan P12')
  ];
  let labSource = null;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      labSource = c;
      break;
    }
  }
  if (!labSource) return false;

  const resolvedTarget = path.resolve(targetFolder);
  if (!fs.existsSync(resolvedTarget)) {
    fs.mkdirSync(resolvedTarget, { recursive: true });
  }

  const files = fs.readdirSync(labSource);
  for (const f of files) {
    const src = path.join(labSource, f);
    const dst = path.join(resolvedTarget, f);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
  return true;
}

// Cari folder di harddisk komputer secara otomatis jika user memilih via browser file picker
function resolveFolderOnDisk(folderName) {
  if (!folderName) return null;
  const home = os.homedir();
  const directCandidates = [
    path.join(home, 'Desktop', folderName),
    path.join(home, 'Downloads', folderName),
    path.join(home, 'Documents', folderName),
    path.join(process.cwd(), folderName),
    path.join(home, folderName),
    path.join(process.cwd(), '..', folderName)
  ];

  for (const c of directCandidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      return path.resolve(c);
    }
  }

  // Pencarian 2 tingkat di folder umum
  const roots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    process.cwd()
  ];

  for (const root of roots) {
    if (fs.existsSync(root)) {
      try {
        const items = fs.readdirSync(root, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            if (item.name.toLowerCase() === folderName.toLowerCase()) {
              return path.resolve(path.join(root, item.name));
            }
            const sub = path.join(root, item.name, folderName);
            if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
              return path.resolve(sub);
            }
          }
        }
      } catch (e) {}
    }
  }

  return null;
}

// Buka dialog folder bawaan OS (Windows / Mac / Linux)
function openOSFolderDialog(callback) {
  if (process.platform === 'win32') {
    const psCmd = `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Pilih folder target penyimpanan yang ingin diaudit dan dibersihkan'; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"`;
    exec(psCmd, { windowsHide: false }, (err, stdout) => {
      if (err) return callback(err);
      const res = stdout ? stdout.trim() : '';
      if (!res) return callback(new Error('Pemilihan folder dibatalkan'));
      callback(null, res);
    });
  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'POSIX path of (choose folder with prompt "Pilih folder target:")'`, (err, stdout) => {
      if (err) return callback(err);
      const res = stdout ? stdout.trim() : '';
      if (!res) return callback(new Error('Pemilihan folder dibatalkan'));
      callback(null, res);
    });
  } else {
    exec(`zenity --file-selection --directory`, (err, stdout) => {
      if (err) return callback(err);
      const res = stdout ? stdout.trim() : '';
      if (!res) return callback(new Error('Pemilihan folder dibatalkan'));
      callback(null, res);
    });
  }
}

// Template HTML UI
function getHTMLTemplate() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Audit & Cleaner - Pembersihan Storage Riil di Harddisk Komputer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #060912;
      --bg-card: #0b1222;
      --bg-card-hover: #101a30;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(56, 189, 248, 0.5);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent-blue: #2563eb;
      --accent-blue-hover: #1d4ed8;
      --accent-cyan: #38bdf8;
      --accent-emerald: #059669;
      --accent-emerald-hover: #047857;
      --accent-amber: #f59e0b;
      --accent-rose: #ef4444;
      --accent-crimson: #e11d48;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --radius-full: 9999px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-base);
      background-image: 
        radial-gradient(circle at 50% 0%, #0d1a34 0%, transparent 60%),
        radial-gradient(circle at 90% 90%, rgba(16, 185, 129, 0.04) 0%, transparent 45%),
        linear-gradient(180deg, #070c18 0%, #050811 100%);
      background-attachment: fixed;
      color: var(--text-main);
      min-height: 100vh;
      line-height: 1.5;
      padding-bottom: 60px;
    }

    code, pre, .font-mono {
      font-family: 'JetBrains Mono', monospace;
    }

    /* Container */
    .container {
      max-width: 1240px;
      margin: 0 auto;
      padding: 24px 20px;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 22px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-box {
      width: 42px;
      height: 42px;
      background: #0284c7;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 18px rgba(2, 132, 199, 0.45);
      flex-shrink: 0;
    }

    .logo-box svg {
      width: 22px;
      height: 22px;
      fill: white;
    }

    .brand-title-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .brand-title-wrap h1 {
      font-size: 1.45rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #ffffff;
    }

    .badge-direct {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #10b981;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: var(--radius-full);
      display: inline-flex;
      align-items: center;
      letter-spacing: 0.02em;
    }

    .brand-subtitle {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-weight: 600;
      font-size: 0.82rem;
      padding: 9px 18px;
      border-radius: var(--radius-md);
      cursor: pointer;
      border: none;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      text-decoration: none;
      user-select: none;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-header-secondary {
      background: rgba(30, 41, 59, 0.75);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .btn-header-secondary:hover {
      background: rgba(51, 65, 85, 0.85);
      color: #ffffff;
    }

    .btn-clean-primary {
      background: linear-gradient(135deg, #e11d48 0%, #be123c 100%);
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(225, 29, 72, 0.35);
    }
    .btn-clean-primary:hover {
      background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);
      box-shadow: 0 6px 18px rgba(225, 29, 72, 0.5);
    }

    .btn-browse-blue {
      background: #2563eb;
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
    }
    .btn-browse-blue:hover {
      background: #1d4ed8;
      box-shadow: 0 6px 18px rgba(37, 99, 235, 0.45);
    }

    .btn-upload-green {
      background: #059669;
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(5, 150, 105, 0.35);
    }
    .btn-upload-green:hover {
      background: #047857;
      box-shadow: 0 6px 18px rgba(5, 150, 105, 0.45);
    }

    .btn-input-gray {
      background: rgba(30, 41, 59, 0.85);
      color: #f1f5f9;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .btn-input-gray:hover {
      background: rgba(51, 65, 85, 0.95);
      color: #ffffff;
    }

    /* Target Harddisk Aktif Card */
    .target-bar-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }

    .target-bar-left {
      display: flex;
      align-items: center;
      gap: 14px;
      flex: 1;
      min-width: 280px;
    }

    .folder-active-icon {
      width: 28px;
      height: 28px;
      fill: #f59e0b;
      flex-shrink: 0;
    }

    .target-label-text {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin-bottom: 2px;
    }

    .target-path-display {
      font-size: 0.9rem;
      word-break: break-all;
    }

    .target-path-display.empty {
      color: #94a3b8;
      font-style: italic;
    }

    .target-path-display.active {
      color: #38bdf8;
      font-weight: 700;
    }

    .target-bar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    /* Dashed Empty State Card (Pilih Folder) */
    .empty-state-dashed-card {
      border: 2px dashed rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      background: rgba(11, 18, 34, 0.6);
      padding: 44px 24px;
      text-align: center;
      margin-bottom: 28px;
      transition: all 0.25s ease;
    }

    .empty-state-big-icon {
      width: 54px;
      height: 54px;
      fill: #f59e0b;
      margin: 0 auto 16px auto;
      display: block;
      filter: drop-shadow(0 4px 12px rgba(245, 158, 11, 0.3));
    }

    .empty-state-dashed-card h2 {
      font-size: 1.35rem;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 10px;
    }

    .empty-state-dashed-card p {
      color: var(--text-muted);
      font-size: 0.88rem;
      max-width: 620px;
      margin: 0 auto 24px auto;
      line-height: 1.6;
    }

    .empty-state-buttons {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    /* 4 Stat Cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }

    @media (max-width: 992px) {
      .metrics-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 576px) {
      .metrics-grid {
        grid-template-columns: 1fr;
      }
    }

    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 20px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    }

    .metric-card.card-blue { border-top: 3px solid #38bdf8; }
    .metric-card.card-purple { border-top: 3px solid #c084fc; }
    .metric-card.card-orange { border-top: 3px solid #f87171; }
    .metric-card.card-teal { border-top: 3px solid #2dd4bf; }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .metric-title {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .metric-corner-icon {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-blue .metric-corner-icon svg { fill: #f59e0b; }
    .card-purple .metric-corner-icon svg { fill: #c084fc; }
    .card-orange .metric-corner-icon svg { fill: #f59e0b; }
    .card-teal .metric-corner-icon svg { fill: #fbbf24; }

    .metric-value {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 8px;
      color: #ffffff;
    }

    .metric-desc {
      font-size: 0.74rem;
      color: var(--text-dim);
    }

    /* Main Table Card (Daftar File Raksasa) */
    .table-container-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 22px;
      margin-bottom: 28px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }

    .table-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 14px;
    }

    .table-title-area {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .cube-icon {
      width: 22px;
      height: 22px;
      fill: #d97706;
    }

    .table-title-area h2 {
      font-size: 1.05rem;
      font-weight: 700;
      color: #ffffff;
    }

    .count-badge-amber {
      background: rgba(245, 158, 11, 0.2);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fbbf24;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-full);
    }

    .search-box {
      position: relative;
    }

    .search-input {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-sm);
      padding: 8px 14px;
      font-size: 0.82rem;
      color: #ffffff;
      outline: none;
      width: 220px;
      transition: all 0.2s ease;
    }

    .search-input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }

    .table-responsive {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.85rem;
    }

    thead th {
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.05em;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    tbody tr {
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      transition: background 0.15s ease;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    tbody td {
      padding: 14px;
      vertical-align: middle;
      color: #ffffff;
    }

    .file-name-wrapper {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .file-type-svg {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      color: #94a3b8;
    }

    .file-name-text {
      font-weight: 600;
      color: #ffffff;
      font-size: 0.88rem;
    }

    .file-path-text {
      color: var(--text-dim);
      font-size: 0.78rem;
      word-break: break-all;
    }

    .size-stacked {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      line-height: 1.15;
    }

    .size-stacked-num {
      font-weight: 700;
      font-size: 0.95rem;
      color: #ffffff;
    }

    .size-stacked-unit {
      font-size: 0.7rem;
      color: var(--text-muted);
      font-weight: 600;
    }

    .format-badge {
      display: inline-block;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #cbd5e1;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: var(--radius-full);
      font-family: 'JetBrains Mono', monospace;
    }

    .status-badge-boros {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fbbf24;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: var(--radius-full);
      line-height: 1.2;
    }

    .status-badge-boros .status-sub {
      font-size: 0.68rem;
      font-weight: 500;
      opacity: 0.9;
    }

    .table-empty-row {
      text-align: center;
      padding: 36px !important;
      color: var(--text-dim);
      font-size: 0.88rem;
    }

    /* Accordion Kelompok Duplikat & File Sampah (Tersedia Di Bawah Tabel) */
    .advanced-section-wrapper {
      margin-top: 16px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      background: var(--bg-card);
      overflow: hidden;
    }

    .advanced-header-toggle {
      padding: 16px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      background: rgba(15, 23, 42, 0.5);
      user-select: none;
      transition: background 0.2s ease;
    }

    .advanced-header-toggle:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .advanced-content {
      display: none;
      padding: 22px;
      border-top: 1px solid var(--border-subtle);
    }

    .advanced-content.open {
      display: block;
    }

    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 14px;
    }

    .accordion-item {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .accordion-item-header {
      padding: 14px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      flex-wrap: wrap;
      gap: 10px;
    }

    .accordion-item-header:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .accordion-item-body {
      display: none;
      padding: 14px 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      background: rgba(8, 12, 22, 0.6);
    }

    .accordion-item.open .accordion-item-body {
      display: block;
    }

    .file-tree-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      font-size: 0.82rem;
      gap: 12px;
    }

    .badge-original {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .badge-duplicate {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #f87171;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    /* Modal Styling */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      padding: 20px;
    }

    .modal-backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }

    .modal-dialog {
      background: #0d1527;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 18px;
      max-width: 520px;
      width: 100%;
      padding: 26px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      transform: scale(0.95);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .modal-backdrop.show .modal-dialog {
      transform: scale(1);
    }

    .modal-shield-wrap {
      width: 48px;
      height: 48px;
      background: rgba(37, 99, 235, 0.15);
      border: 1px solid rgba(37, 99, 235, 0.3);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
      box-shadow: 0 0 20px rgba(37, 99, 235, 0.2);
    }

    .modal-shield-wrap svg {
      width: 26px;
      height: 26px;
      fill: #38bdf8;
    }

    .modal-dialog h3 {
      font-size: 1.22rem;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 8px;
    }

    .modal-subtitle {
      font-size: 0.82rem;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .modal-path-highlight {
      color: #38bdf8;
      font-size: 0.84rem;
      font-weight: 600;
      word-break: break-all;
      margin-top: 6px;
      display: block;
    }

    .modal-stat-box {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-md);
      padding: 16px 18px;
      margin: 18px 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .modal-stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .modal-stat-row.highlight-green {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 10px;
      margin-top: 2px;
      color: #ffffff;
      font-weight: 600;
    }

    .modal-stat-row.highlight-green .val {
      color: #10b981;
      font-size: 1.15rem;
      font-weight: 800;
    }

    .modal-guarantee-note {
      font-size: 0.76rem;
      color: var(--text-dim);
      line-height: 1.5;
      margin-bottom: 22px;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
    }

    /* Input Path Modal */
    .input-modal-box {
      margin: 16px 0;
    }
    .input-modal-box input {
      width: 100%;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      font-size: 0.88rem;
      color: #ffffff;
      outline: none;
      font-family: 'JetBrains Mono', monospace;
    }
    .input-modal-box input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.25);
    }

    .presets-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .preset-btn {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-size: 0.72rem;
      font-family: 'JetBrains Mono', monospace;
      padding: 5px 10px;
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .preset-btn:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }

    /* Floating Toast Notifications */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 9999;
      pointer-events: none;
    }

    .toast-item {
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 12px 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
      font-size: 0.82rem;
      color: #ffffff;
      max-width: 440px;
      pointer-events: auto;
      animation: toastSlideIn 0.25s ease;
      transition: all 0.3s ease;
    }

    @keyframes toastSlideIn {
      from { transform: translateY(16px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .toast-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 0.78rem;
      font-weight: 800;
    }

    .toast-info .toast-icon {
      background: #0284c7;
      color: white;
    }

    .toast-success .toast-icon {
      background: #10b981;
      color: white;
    }

    .toast-error .toast-icon {
      background: #ef4444;
      color: white;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #ffffff;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>

  <!-- Hidden HTML5 File Picker untuk Mode Upload/Pilih Folder -->
  <input type="file" id="osFolderPickerInput" webkitdirectory directory multiple style="display:none;" onchange="handleFolderSelected(event)">

  <div class="container">
    
    <!-- Top Header -->
    <header>
      <div class="brand">
        <div class="logo-box">
          <!-- Lightning Bolt SVG -->
          <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <div>
          <div class="brand-title-wrap">
            <h1>Storage Audit & Cleaner</h1>
            <span class="badge-direct">Direct Execution</span>
          </div>
          <div class="brand-subtitle">Pembersihan Storage Riil di Harddisk Komputer</div>
        </div>
      </div>
      <div class="header-actions">
        <button id="btnRescan" class="btn btn-header-secondary" onclick="handleRescan()">
          <!-- Refresh / Scan Icon -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          <span>Pindai Ulang</span>
        </button>
        <button id="btnOpenCleanModal" class="btn btn-clean-primary" onclick="openCleanModal()">
          <!-- Broom / Clean Icon -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          <span>Bersihkan Duplikat & Sampah</span>
        </button>
      </div>
    </header>

    <!-- Target Harddisk Aktif Bar -->
    <div class="target-bar-card">
      <div class="target-bar-left">
        <!-- Yellow Folder SVG -->
        <svg class="folder-active-icon" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
        <div>
          <div class="target-label-text">TARGET HARDDISK AKTIF:</div>
          <div id="targetDisplayPath" class="target-path-display empty font-mono">Belum Ada Folder yang Dipilih</div>
        </div>
      </div>
      <div class="target-bar-actions">

        <button class="btn btn-upload-green" onclick="triggerHTML5Upload()">
          <!-- Upload Icon -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Pilih / Upload Folder</span>
        </button>
        <button class="btn btn-input-gray" onclick="openManualPathModal()">
          <!-- Note / Input Icon -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Input Path</span>
        </button>
      </div>
    </div>

    <!-- Dashed Empty State Card (Pilih Folder untuk Memulai Audit) -->
    <div id="emptyStateCard" class="empty-state-dashed-card">
      <svg class="empty-state-big-icon" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
      <h2>Silakan Pilih Folder untuk Memulai Audit</h2>
      <p>Belum ada folder yang dipilih. Silakan pilih folder di harddisk komputer Anda yang ingin dipindai, dianalisis file raksasanya, dan dibersihkan duplikatnya secara riil tanpa membuat salinan.</p>
      <div class="empty-state-buttons">

        <button class="btn btn-upload-green" onclick="triggerHTML5Upload()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Pilih / Upload Folder</span>
        </button>
        <button class="btn btn-input-gray" onclick="openManualPathModal()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>
          <span>Ketik Path Manual</span>
        </button>
      </div>
    </div>

    <!-- 4 Metric Stat Cards -->
    <div class="metrics-grid">
      <!-- Card 1: Total File -->
      <div class="metric-card card-blue">
        <div class="metric-header">
          <span class="metric-title">TOTAL FILE DI-SCAN</span>
          <div class="metric-corner-icon">
            <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          </div>
        </div>
        <div class="metric-value font-mono" id="statTotalFiles">-</div>
        <div class="metric-desc">STG-01: Memindai seluruh file rekursif</div>
      </div>

      <!-- Card 2: Total Kapasitas -->
      <div class="metric-card card-purple">
        <div class="metric-header">
          <span class="metric-title">TOTAL KAPASITAS FOLDER</span>
          <div class="metric-corner-icon">
            <svg viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
          </div>
        </div>
        <div class="metric-value font-mono" id="statTotalCapacity">-</div>
        <div class="metric-desc">Ukuran data fisik asli di disk</div>
      </div>

      <!-- Card 3: File Raksasa -->
      <div class="metric-card card-orange">
        <div class="metric-header">
          <span class="metric-title">FILE RAKSASA (≥ 2 MB)</span>
          <div class="metric-corner-icon">
            <svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          </div>
        </div>
        <div class="metric-value font-mono" id="statGiantFiles">-</div>
        <div class="metric-desc">STG-03: Terdeteksi file boros kuota</div>
      </div>

      <!-- Card 4: Potensi Hemat -->
      <div class="metric-card card-teal">
        <div class="metric-header">
          <span class="metric-title">POTENSI HEMAT RUANG</span>
          <div class="metric-corner-icon">
            <svg viewBox="0 0 24 24"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>
          </div>
        </div>
        <div class="metric-value font-mono" id="statPotentialSavings">-</div>
        <div class="metric-desc">Duplikat identik &amp; file sampah .tmp</div>
      </div>
    </div>

    <!-- Tabel File Raksasa Card -->
    <div class="table-container-card">
      <div class="table-toolbar">
        <div class="table-title-area">
          <svg class="cube-icon" viewBox="0 0 24 24"><path d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A.991.991 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9z"/></svg>
          <h2>Daftar File Raksasa (≥ 2 MB)</h2>
          <span class="count-badge-amber" id="badgeGiantCount">0 file</span>
        </div>
        <div class="search-box">
          <input type="text" id="giantSearchInput" class="search-input" placeholder="Cari file raksasa..." oninput="handleFilterGiants()">
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th style="width: 32%;">NAMA FILE</th>
              <th style="width: 44%;">PATH LOKASI HARDDISK</th>
              <th style="width: 10%;">UKURAN</th>
              <th style="width: 7%;">FORMAT</th>
              <th style="width: 7%;">STATUS</th>
            </tr>
          </thead>
          <tbody id="giantTableBody">
            <tr>
              <td colspan="5" class="table-empty-row">Belum ada folder yang dipilih untuk diaudit.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Section Lanjutan: Detail Kelompok Duplikat & File Sampah (Sesuai Kepatuhan SRS / README) -->
    <div class="advanced-section-wrapper" id="advancedSectionWrapper" style="display:none;">
      <div class="advanced-header-toggle" onclick="toggleAdvancedSection()">
        <div style="display:flex; align-items:center; gap:10px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span style="font-weight:700; font-size:0.92rem; color:#ffffff;">Rincian Kelompok Duplikat (SHA-256) &amp; Sampah .tmp</span>
          <span class="count-badge-amber" id="badgeDupGroupCount">0 grup</span>
        </div>
        <div style="font-size:0.78rem; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
          <span id="txtToggleAdvanced">Klik untuk melihat detail file duplikat</span>
          <svg id="arrowToggleAdvanced" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="advanced-content" id="advancedContent">
        <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px;">
          Setiap grup membandingkan hash file SHA-256 yang identik. Sistem menjamin 1 file orisinil dipertahankan dan sisanya dibersihkan.
        </p>
        <div class="accordion-list" id="duplicateAccordionList">
          <!-- Render via JS -->
        </div>
      </div>
    </div>

  </div>

  <!-- Modal Konfirmasi Pembersihan Harddisk Asli -->
  <div id="cleanConfirmModal" class="modal-backdrop">
    <div class="modal-dialog">
      <div class="modal-shield-wrap">
        <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
      </div>
      <h3>Konfirmasi Pembersihan Harddisk Asli</h3>
      <div class="modal-subtitle">
        Tindakan ini akan <strong>LANGSUNG MENGHAPUS FILE DUPLIKAT DAN FILE .TMP</strong> dari harddisk asli pada folder:
        <span class="modal-path-highlight font-mono" id="modalTargetFolderText"></span>
      </div>

      <div class="modal-stat-box font-mono">
        <div class="modal-stat-row">
          <span>Salinan Duplikat yang akan Dihapus:</span>
          <span id="modalRedundantCount" style="color:#ffffff; font-weight:700;">21 file</span>
        </div>
        <div class="modal-stat-row">
          <span>File Sampah Cache (.tmp):</span>
          <span id="modalTmpCount" style="color:#ffffff; font-weight:700;">0 file</span>
        </div>
        <div class="modal-stat-row">
          <span>Total File yang Dibersihkan Fisik:</span>
          <span id="modalTotalCleanedCount" style="color:#ffffff; font-weight:700;">21 file</span>
        </div>
        <div class="modal-stat-row highlight-green">
          <span>Ruang Harddisk yang Dipulihkan:</span>
          <span class="val" id="modalSavingsText">18 MB</span>
        </div>
      </div>

      <div class="modal-guarantee-note">
        💡 <strong>Garansi Keamanan:</strong> 1 File master asli per kelompok duplikat 100% dijamin tetap tersimpan rapi dan tidak akan terhapus.
      </div>

      <div class="modal-actions">
        <button class="btn btn-header-secondary" onclick="closeCleanModal()">Batal</button>
        <button id="btnExecuteClean" class="btn btn-clean-primary" onclick="confirmExecuteClean()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span>Ya, Bersihkan Langsung di Harddisk</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Modal Manual Input Path -->
  <div id="manualPathModal" class="modal-backdrop">
    <div class="modal-dialog">
      <h3 style="margin-bottom:6px;">Input Path Folder Harddisk</h3>
      <div class="modal-subtitle">
        Ketik atau tempel path lengkap folder lokal di harddisk Anda yang ingin dipindai:
      </div>
      <div class="input-modal-box">
        <input type="text" id="manualPathField" placeholder="Contoh: C:\\Users\\...\\Downloads_Lab atau ./Bahan Latihan P12">
        <div class="presets-container">
          <span style="font-size:0.72rem; color:var(--text-dim); display:flex; align-items:center;">Pilihan Cepat:</span>
          <button class="preset-btn" onclick="applyPresetPath('C:/Users/Student/Desktop/Downloads_Lab')">Downloads_Lab (Desktop)</button>
          <button class="preset-btn" onclick="applyPresetPath('./Bahan Latihan P12')">./Bahan Latihan P12</button>
          <button class="preset-btn" onclick="applyPresetPath('.')">. (Workspace Root)</button>
          <button class="preset-btn" style="color:#34d399;" onclick="handleResetSampleData()">Reset Bahan Uji</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-header-secondary" onclick="closeManualPathModal()">Batal</button>
        <button class="btn btn-browse-blue" onclick="submitManualPath()">
          <span>Pindai Folder</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div id="toastContainer" class="toast-container"></div>

  <script>
    let currentAuditData = null;
    let activeFolderPath = null;

    // Toast Generator
    function showToast(message, type = 'success') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast-item toast-' + type;

      let iconHtml = '✓';
      if (type === 'info') iconHtml = 'i';
      if (type === 'error') iconHtml = '✕';

      toast.innerHTML = \`
        <div class="toast-icon">\${iconHtml}</div>
        <div style="line-height:1.4;">\${message}</div>
      \`;

      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
      }, 4200);
    }

    // SVG icon helper sesuai format file
    function getFileIconSVG(format) {
      const f = (format || '').toUpperCase();
      if (f === 'PDF') {
        return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>\`;
      }
      if (f === 'ZIP' || f === 'RAR' || f === '7Z' || f === 'TAR') {
        return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="15"/><line x1="10" y1="5" x2="14" y2="5"/><line x1="10" y1="9" x2="14" y2="9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>\`;
      }
      if (f === 'PPTX' || f === 'PPT') {
        return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h20v14H2z"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>\`;
      }
      if (f === 'MP4' || f === 'MKV' || f === 'AVI' || f === 'MOV') {
        return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 8 16 12 10 16 10 8"/></svg>\`;
      }
      if (f === 'DOCX' || f === 'DOC' || f === 'TXT') {
        return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>\`;
      }
      return \`<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>\`;
    }

    // Render Data Audit ke Antarmuka
    function renderAuditResults(data) {
      currentAuditData = data;
      activeFolderPath = data.resolvedTarget;

      // Update Target Display Bar
      const displayEl = document.getElementById('targetDisplayPath');
      displayEl.textContent = data.resolvedTarget;
      displayEl.className = 'target-path-display active font-mono';

      // Sembunyikan Dashed Empty State Card
      document.getElementById('emptyStateCard').style.display = 'none';

      // Update 4 Stat Metric Cards
      document.getElementById('statTotalFiles').textContent = data.totalFiles;
      document.getElementById('statTotalCapacity').textContent = data.totalCapacityMB;
      document.getElementById('statGiantFiles').textContent = data.giantCount;
      document.getElementById('statPotentialSavings').textContent = data.potentialSavingsMB;

      // Update Badge Tabel File Raksasa
      document.getElementById('badgeGiantCount').textContent = data.giantCount + ' file';

      // Render Baris Tabel File Raksasa
      renderGiantTable(data.giantFiles);

      // Render Kelompok Duplikat di Bagian Bawah
      document.getElementById('advancedSectionWrapper').style.display = 'block';
      document.getElementById('badgeDupGroupCount').textContent = data.duplicateGroupCount + ' grup';
      renderDuplicateAccordions(data.duplicateGroups);
    }

    // Render Tabel File Raksasa
    function renderGiantTable(list) {
      const tbody = document.getElementById('giantTableBody');
      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty-row">Tidak ada file raksasa (&ge; 2 MB) ditemukan pada folder ini.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(f => \`
        <tr>
          <td>
            <div class="file-name-wrapper">
              \${getFileIconSVG(f.format)}
              <span class="file-name-text">\${f.name}</span>
            </div>
          </td>
          <td>
            <div class="file-path-text font-mono">\${f.absolutePath}</div>
          </td>
          <td>
            <div class="size-stacked font-mono">
              <span class="size-stacked-num">\${f.sizeValue}</span>
              <span class="size-stacked-unit">\${f.sizeUnit}</span>
            </div>
          </td>
          <td>
            <span class="format-badge">\${f.format}</span>
          </td>
          <td>
            <span class="status-badge-boros">
              <span>&ge; 2 MB</span>
              <span class="status-sub">(Boros)</span>
            </span>
          </td>
        </tr>
      \`).join('');
    }

    // Search filter tabel file raksasa
    function handleFilterGiants() {
      if (!currentAuditData) return;
      const query = document.getElementById('giantSearchInput').value.toLowerCase();
      const filtered = currentAuditData.giantFiles.filter(f => 
        f.name.toLowerCase().includes(query) || f.absolutePath.toLowerCase().includes(query)
      );
      renderGiantTable(filtered);
    }

    // Render Accordion Kelompok Duplikat
    function renderDuplicateAccordions(groups) {
      const container = document.getElementById('duplicateAccordionList');
      if (!groups || groups.length === 0) {
        container.innerHTML = '<div style="color:#10b981; font-weight:600; font-size:0.85rem; padding:10px 0;">✓ Bersih! Tidak ada file duplikat identik.</div>';
        return;
      }

      container.innerHTML = groups.map((g, idx) => \`
        <div class="accordion-item \${idx === 0 ? 'open' : ''}" id="acc-item-\${g.groupId}">
          <div class="accordion-item-header" onclick="toggleAccItem('acc-item-\${g.groupId}')">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-weight:700; color:#ffffff; font-size:0.85rem;">Grup #\${g.groupId}</span>
              <code style="font-size:0.75rem; color:#94a3b8; background:rgba(255,255,255,0.06); padding:2px 8px; border-radius:4px;">\${g.shortHash}</code>
              <span style="font-size:0.74rem; color:#cbd5e1;">\${g.fileCount} File Kembar</span>
            </div>
            <div style="display:flex; align-items:center; gap:14px;">
              <span style="font-size:0.76rem; color:#10b981; font-weight:700;">Hemat: \${g.savingsMB}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
          <div class="accordion-item-body">
            \${g.files.map(f => \`
              <div class="file-tree-row">
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:75%;">
                  <span style="font-weight:600; color:\${f.isOriginal ? '#ffffff' : '#f87171'};">\${f.name}</span>
                  <span class="font-mono" style="font-size:0.72rem; color:var(--text-dim); margin-left:8px;">\${f.absolutePath}</span>
                </div>
                <div>
                  \${f.isOriginal 
                    ? '<span class="badge-original">✓ ASLI (DIPERTAHANKAN)</span>' 
                    : '<span class="badge-duplicate">✕ SALINAN KEMBAR (AKAN DIHAPUS)</span>'}
                </div>
              </div>
            \`).join('')}
          </div>
        </div>
      \`).join('');
    }

    function toggleAccItem(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }

    function toggleAdvancedSection() {
      const content = document.getElementById('advancedContent');
      const arrow = document.getElementById('arrowToggleAdvanced');
      const txt = document.getElementById('txtToggleAdvanced');
      content.classList.toggle('open');
      if (content.classList.contains('open')) {
        arrow.style.transform = 'rotate(180deg)';
        txt.textContent = 'Sembunyikan rincian';
      } else {
        arrow.style.transform = 'rotate(0deg)';
        txt.textContent = 'Klik untuk melihat detail file duplikat';
      }
    }

    // Pindai folder via API
    async function scanFolderAPI(folderPath) {
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });
        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Gagal memindai folder');
        }
        renderAuditResults(result.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // Pemicu 1: Browse Folder Dialog OS (Windows/Mac)
    async function triggerBrowseOS() {
      showToast('Membuka dialog pemilihan folder di sistem operasi...', 'info');
      try {
        const res = await fetch('/api/browse-folder', { method: 'POST' });
        const result = await res.json();
        if (result.success && result.folderPath) {
          const folderName = result.folderPath.split(/[\\\\/]/).filter(Boolean).pop();
          showToast(\`Mencari lokasi fisik folder '\${folderName}' di harddisk...\`, 'info');
          setTimeout(() => {
            showToast(\`Berhasil terhubung langsung ke harddisk: \${result.folderPath}\`, 'success');
            scanFolderAPI(result.folderPath);
          }, 400);
        } else if (result.error && !result.error.includes('dibatalkan')) {
          showToast(result.error, 'error');
        }
      } catch (e) {
        showToast('Gagal memicu dialog folder OS: ' + e.message, 'error');
      }
    }

    // Pemicu 2: HTML5 File Input Picker (Pilih / Upload Folder)
    function triggerHTML5Upload() {
      document.getElementById('osFolderPickerInput').click();
    }

    async function handleFolderSelected(e) {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const firstRel = files[0].webkitRelativePath || '';
      const folderName = firstRel.split('/')[0] || 'Downloads_Lab';

      showToast(\`Mencari lokasi fisik folder '\${folderName}' di harddisk...\`, 'info');

      try {
        const res = await fetch('/api/resolve-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName })
        });
        const result = await res.json();

        if (result.success && result.folderPath) {
          setTimeout(() => {
            showToast(\`Berhasil terhubung langsung ke harddisk: \${result.folderPath}\`, 'success');
            scanFolderAPI(result.folderPath);
          }, 350);
        } else {
          showToast(\`Folder '\${folderName}' dipilih. Membuka konfirmasi path...\`, 'info');
          openManualPathModal(folderName);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }

      // Reset file input agar bisa dipilih ulang
      e.target.value = '';
    }

    // Pemicu 3: Input Path Manual
    function openManualPathModal(prefill) {
      const field = document.getElementById('manualPathField');
      if (prefill) {
        field.value = prefill;
      } else if (activeFolderPath) {
        field.value = activeFolderPath;
      } else {
        field.value = 'C:/Users/Student/Desktop/Downloads_Lab';
      }
      document.getElementById('manualPathModal').classList.add('show');
    }

    function closeManualPathModal() {
      document.getElementById('manualPathModal').classList.remove('show');
    }

    function applyPresetPath(p) {
      document.getElementById('manualPathField').value = p;
    }

    function submitManualPath() {
      const val = document.getElementById('manualPathField').value.trim();
      if (!val) {
        showToast('Silakan masukkan path folder target.', 'error');
        return;
      }
      closeManualPathModal();
      showToast(\`Berhasil terhubung langsung ke harddisk: \${val}\`, 'success');
      scanFolderAPI(val);
    }

    // Pindai Ulang
    function handleRescan() {
      if (!activeFolderPath) {
        showToast('Belum ada folder yang dipilih. Silakan pilih folder terlebih dahulu.', 'error');
        return;
      }
      showToast(\`Memindai ulang folder: \${activeFolderPath}...\`, 'info');
      scanFolderAPI(activeFolderPath);
    }

    // Modal Konfirmasi Bersihkan
    function openCleanModal() {
      if (!currentAuditData) {
        showToast('Silakan pilih dan pindai folder terlebih dahulu sebelum membersihkan.', 'error');
        return;
      }

      const redundant = currentAuditData.totalRedundantFiles;
      const tmp = currentAuditData.tmpCount;
      const total = redundant + tmp;

      if (total === 0) {
        showToast('Folder target sudah bersih! Tidak ada file duplikat atau sampah untuk dibersihkan.', 'success');
        return;
      }

      document.getElementById('modalTargetFolderText').textContent = activeFolderPath;
      document.getElementById('modalRedundantCount').textContent = redundant + ' file';
      document.getElementById('modalTmpCount').textContent = tmp + ' file';
      document.getElementById('modalTotalCleanedCount').textContent = total + ' file';
      document.getElementById('modalSavingsText').textContent = currentAuditData.potentialSavingsMB;

      document.getElementById('cleanConfirmModal').classList.add('show');
    }

    function closeCleanModal() {
      document.getElementById('cleanConfirmModal').classList.remove('show');
    }

    // Eksekusi Bersihkan Langsung di Harddisk
    async function confirmExecuteClean() {
      const btn = document.getElementById('btnExecuteClean');
      const origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div><span>Membersihkan di harddisk...</span>';

      try {
        const res = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: activeFolderPath })
        });
        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Gagal mengeksekusi pembersihan.');
        }

        closeCleanModal();
        renderAuditResults(result.data.updatedAudit);
        showToast(\`SUKSES RIIL! \${result.data.deletedCount} file telah dihapus langsung dari harddisk (\${result.data.freedMB} ruang pulih).\`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }

    // Reset Sample Data Helper
    async function handleResetSampleData() {
      if (!confirm('Apakah Anda ingin mereset/mengembalikan file bahan uji asli ke folder target?')) return;
      try {
        const target = document.getElementById('manualPathField').value.trim() || activeFolderPath || 'C:/Users/Student/Desktop/Downloads_Lab';
        const res = await fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: target })
        });
        const r = await res.json();
        if (r.success) {
          showToast('Data latihan berhasil dipulihkan!');
          closeManualPathModal();
          scanFolderAPI(target);
        } else {
          showToast(r.error || 'Gagal merestore data latihan.', 'error');
        }
      } catch (e) {
        showToast(e.message, 'error');
      }
    }
  </script>
</body>
</html>`;
}

// HTTP Server Handler
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Helper kirim JSON
  const sendJSON = (statusCode, obj) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // GET / - Halaman Dashboard Web UI
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTMLTemplate());
    return;
  }

  // Helper untuk membaca request body JSON
  const parseBody = (callback) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        callback(null, parsed);
      } catch (err) {
        callback(err);
      }
    });
  };

  // POST /api/scan - Pemindaian target folder secara dinamis
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    parseBody((err, data) => {
      if (err) return sendJSON(400, { success: false, error: 'Format JSON request tidak valid' });
      const targetFolder = (data && data.folderPath) ? data.folderPath.trim() : DEFAULT_TARGET_DIR;
      try {
        const audit = processAudit(targetFolder);
        sendJSON(200, { success: true, data: audit });
      } catch (auditErr) {
        sendJSON(400, { success: false, error: auditErr.message });
      }
    });
    return;
  }

  // POST /api/clean - Pembersihan duplikat & sampah in-place
  if (req.method === 'POST' && url.pathname === '/api/clean') {
    parseBody((err, data) => {
      if (err) return sendJSON(400, { success: false, error: 'Format JSON request tidak valid' });
      const targetFolder = (data && data.folderPath) ? data.folderPath.trim() : DEFAULT_TARGET_DIR;
      try {
        const cleanResult = executeCleanInPlace(targetFolder);
        sendJSON(200, { success: true, data: cleanResult });
      } catch (cleanErr) {
        sendJSON(400, { success: false, error: cleanErr.message });
      }
    });
    return;
  }

  // POST atau GET /api/browse-folder - Buka Dialog Folder OS
  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/browse-folder') {
    openOSFolderDialog((err, selectedPath) => {
      if (err) {
        sendJSON(200, { success: false, error: err.message });
      } else {
        sendJSON(200, { success: true, folderPath: selectedPath });
      }
    });
    return;
  }

  // POST /api/resolve-folder - Cari lokasi fisik folder di harddisk jika user memilih lewat HTML5 picker
  if (req.method === 'POST' && url.pathname === '/api/resolve-folder') {
    parseBody((err, data) => {
      if (err) return sendJSON(400, { success: false, error: 'Format JSON tidak valid' });
      const folderName = (data && data.folderName) ? data.folderName.trim() : '';
      const resolved = resolveFolderOnDisk(folderName);
      if (resolved) {
        sendJSON(200, { success: true, folderPath: resolved });
      } else {
        sendJSON(200, { success: false, message: 'Folder tidak ditemukan otomatis di lokasi standar' });
      }
    });
    return;
  }

  // POST /api/restore - Mengembalikan bahan latihan asli untuk kemudahan re-testing
  if (req.method === 'POST' && url.pathname === '/api/restore') {
    parseBody((err, data) => {
      if (err) return sendJSON(400, { success: false, error: 'Format JSON request tidak valid' });
      const targetFolder = (data && data.folderPath) ? data.folderPath.trim() : DEFAULT_TARGET_DIR;
      try {
        const ok = restoreSampleData(targetFolder);
        if (ok) {
          sendJSON(200, { success: true, message: 'Data latihan berhasil direstore' });
        } else {
          sendJSON(400, { success: false, error: 'Folder cadangan latihan tidak ditemukan' });
        }
      } catch (restoreErr) {
        sendJSON(400, { success: false, error: restoreErr.message });
      }
    });
    return;
  }

  // 404 Route Not Found
  sendJSON(404, { success: false, error: 'Route endpoint tidak ditemukan' });
});

// Auto buka dashboard di browser
function openBrowser(targetUrl) {
  const startCmd = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${startCmd} ${targetUrl}`, (err) => {
    if (err) {
      console.log(`[Info] Silakan buka manual URL di browser: ${targetUrl}`);
    }
  });
}

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log(`================================================================`);
  console.log(`  Storage Audit & Cleaner - Server Berjalan di ${localUrl}`);
  console.log(`  Target Default: ${DEFAULT_TARGET_DIR}`);
  console.log(`  Modul Native Node.js: http, fs, path, crypto, os, child_process`);
  console.log(`================================================================`);
  openBrowser(localUrl);
});
