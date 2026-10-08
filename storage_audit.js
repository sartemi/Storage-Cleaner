/**
 * StorageAudit Pro - storage_audit.js
 * Sistem Audit Penyimpanan & Pembersih Duplikat In-Place
 * Dijalankan dengan runtime native Node.js tanpa dependensi npm eksternal.
 * Modul bawaan: http, fs, path, crypto, child_process
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
      giantFiles.push({
        name: file.name,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        sizeKB: (file.sizeBytes / 1024).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' KB',
        sizeMB: (file.sizeBytes / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB',
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
        sizeKB: (singleFileSize / 1024).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' KB',
        sizeMB: (singleFileSize / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB',
        savingsBytes: groupSavings,
        savingsMB: (groupSavings / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB',
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
    // jika bukan duplikat yang sudah dihitung
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
    totalCapacityMB: (totalBytes / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB',
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
    potentialSavingsMB: (potentialSavingsBytes / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB'
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
    freedMB: (freedBytes / (1024 * 1024)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB',
    errors: errors,
    updatedAudit: updatedAudit
  };
}

// Restore / reset helper dari cadangan lokal (jika ada)
function restoreSampleData(targetFolder) {
  const labSource = 'C:/Users/Student/Downloads/Downloads_Lab';
  const resolvedTarget = path.resolve(targetFolder);

  if (fs.existsSync(labSource)) {
    if (!fs.existsSync(resolvedTarget)) {
      fs.mkdirSync(resolvedTarget, { recursive: true });
    }
    const files = fs.readdirSync(labSource);
    for (const f of files) {
      const src = path.join(labSource, f);
      const dst = path.join(resolvedTarget, f);
      fs.copyFileSync(src, dst);
    }
    return true;
  }
  return false;
}

// Template HTML UI
function getHTMLTemplate() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StorageAudit Pro - Audit & Pembersih Penyimpanan</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #090d16;
      --bg-surface: #0f172a;
      --bg-card: rgba(17, 24, 39, 0.85);
      --bg-card-hover: rgba(30, 41, 59, 0.7);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(99, 102, 241, 0.5);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent-primary: #6366f1;
      --accent-primary-hover: #4f46e5;
      --accent-emerald: #10b981;
      --accent-emerald-dim: rgba(16, 185, 129, 0.15);
      --accent-amber: #f59e0b;
      --accent-amber-dim: rgba(245, 158, 11, 0.15);
      --accent-rose: #ef4444;
      --accent-rose-dim: rgba(239, 68, 68, 0.15);
      --accent-blue: #38bdf8;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 18px;
      --radius-full: 9999px;
      --shadow-glow: 0 0 25px rgba(99, 102, 241, 0.15);
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
        radial-gradient(circle at 15% 10%, rgba(99, 102, 241, 0.12) 0%, transparent 40%),
        radial-gradient(circle at 85% 80%, rgba(16, 185, 129, 0.08) 0%, transparent 45%),
        linear-gradient(180deg, #090d16 0%, #060911 100%);
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
      padding: 28px 20px;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .logo-icon {
      width: 46px;
      height: 46px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(99, 102, 241, 0.35);
    }

    .logo-icon svg {
      width: 26px;
      height: 26px;
      fill: white;
    }

    .brand-text h1 {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(90deg, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .header-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border-subtle);
      padding: 6px 14px;
      border-radius: var(--radius-full);
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-emerald);
      box-shadow: 0 0 10px var(--accent-emerald);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.9); }
    }

    /* Target Folder Controller */
    .control-panel {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 24px;
      margin-bottom: 28px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    }

    .control-label {
      font-size: 0.82rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .path-input-group {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .input-wrapper {
      position: relative;
      flex: 1;
      min-width: 280px;
    }

    .input-wrapper svg {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      color: var(--text-dim);
    }

    .path-input {
      width: 100%;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text-main);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.95rem;
      padding: 12px 14px 12px 42px;
      border-radius: var(--radius-md);
      transition: all 0.2s ease;
      outline: none;
    }

    .path-input:focus {
      border-color: var(--accent-primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      padding: 12px 22px;
      border-radius: var(--radius-md);
      cursor: pointer;
      border: none;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      text-decoration: none;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: #ffffff;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
    }

    .btn-danger {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: #ffffff;
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
    }

    .btn-danger:hover {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.45);
    }

    .btn-secondary {
      background: rgba(30, 41, 59, 0.8);
      color: var(--text-muted);
      border: 1px solid var(--border-subtle);
    }

    .btn-secondary:hover {
      background: rgba(51, 65, 85, 0.8);
      color: var(--text-main);
    }

    .path-presets {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      flex-wrap: wrap;
    }

    .preset-label {
      font-size: 0.78rem;
      color: var(--text-dim);
    }

    .preset-chip {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'JetBrains Mono', monospace;
    }

    .preset-chip:hover {
      background: rgba(99, 102, 241, 0.2);
      border-color: rgba(99, 102, 241, 0.4);
      color: var(--text-main);
    }

    /* Metric Cards Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 18px;
      margin-bottom: 32px;
    }

    .metric-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.16);
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
    }

    .metric-card.card-blue::before { background: linear-gradient(90deg, #38bdf8, #6366f1); }
    .metric-card.card-purple::before { background: linear-gradient(90deg, #818cf8, #c084fc); }
    .metric-card.card-amber::before { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .metric-card.card-emerald::before { background: linear-gradient(90deg, #10b981, #34d399); }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .metric-title {
      font-size: 0.82rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
    }

    .metric-icon-wrap {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-blue .metric-icon-wrap { background: rgba(56, 189, 248, 0.12); color: #38bdf8; }
    .card-purple .metric-icon-wrap { background: rgba(168, 85, 247, 0.12); color: #c084fc; }
    .card-amber .metric-icon-wrap { background: var(--accent-amber-dim); color: var(--accent-amber); }
    .card-emerald .metric-icon-wrap { background: var(--accent-emerald-dim); color: var(--accent-emerald); }

    .metric-icon-wrap svg {
      width: 20px;
      height: 20px;
    }

    .metric-value {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 6px;
      color: var(--text-main);
    }

    .metric-desc {
      font-size: 0.78rem;
      color: var(--text-dim);
    }

    /* Content Layout (Tabs / Sections) */
    .section-tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 12px;
      flex-wrap: wrap;
    }

    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      font-size: 0.9rem;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: var(--radius-md);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.04);
    }

    .tab-btn.active {
      color: #ffffff;
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.4);
    }

    .tab-badge {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      background: rgba(255, 255, 255, 0.1);
    }

    .tab-btn.active .tab-badge {
      background: var(--accent-primary);
      color: white;
    }

    /* Section Container */
    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
      animation: fadeIn 0.25s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .section-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    }

    .section-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .search-input-box {
      position: relative;
      min-width: 260px;
    }

    .search-input-box svg {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      width: 16px;
      height: 16px;
      color: var(--text-dim);
    }

    .search-input {
      width: 100%;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px 12px 8px 36px;
      font-size: 0.85rem;
      color: var(--text-main);
      outline: none;
    }

    .search-input:focus {
      border-color: var(--accent-primary);
    }

    /* Table Styling */
    .table-responsive {
      overflow-x: auto;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.88rem;
    }

    thead th {
      background: rgba(15, 23, 42, 0.95);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.74rem;
      letter-spacing: 0.05em;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
    }

    tbody tr {
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      transition: background 0.15s ease;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    tbody td {
      padding: 14px 16px;
      color: var(--text-main);
      vertical-align: middle;
    }

    .file-name-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
    }

    .file-type-icon {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      background: rgba(99, 102, 241, 0.15);
      color: var(--accent-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .file-type-icon svg {
      width: 18px;
      height: 18px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .badge-giant {
      background: var(--accent-amber-dim);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-original {
      background: var(--accent-emerald-dim);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-duplicate {
      background: var(--accent-rose-dim);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .badge-neutral {
      background: rgba(148, 163, 184, 0.12);
      color: #cbd5e1;
    }

    /* Accordion Styling */
    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .accordion-item {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .accordion-item.open {
      border-color: rgba(99, 102, 241, 0.4);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }

    .accordion-header {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      gap: 12px;
      flex-wrap: wrap;
    }

    .accordion-header:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .group-left {
      display: flex;
      align-items: center;
      gap: 14px;
      flex: 1;
      min-width: 280px;
    }

    .group-number {
      font-size: 0.85rem;
      font-weight: 700;
      color: #ffffff;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.3);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
    }

    .group-hash {
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .group-hash code {
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      color: #cbd5e1;
    }

    .group-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .chevron-icon {
      width: 20px;
      height: 20px;
      color: var(--text-dim);
      transition: transform 0.2s ease;
    }

    .accordion-item.open .chevron-icon {
      transform: rotate(180deg);
      color: var(--accent-primary);
    }

    .accordion-body {
      display: none;
      padding: 0 20px 18px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(10, 15, 28, 0.5);
    }

    .accordion-item.open .accordion-body {
      display: block;
    }

    .file-tree {
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .file-tree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: var(--radius-sm);
      gap: 12px;
      flex-wrap: wrap;
    }

    .file-tree-item.is-original {
      border-left: 3px solid var(--accent-emerald);
      background: rgba(16, 185, 129, 0.03);
    }

    .file-tree-item.is-duplicate {
      border-left: 3px solid var(--accent-rose);
      background: rgba(239, 68, 68, 0.03);
    }

    .file-info-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .file-info-name {
      font-weight: 600;
      font-size: 0.88rem;
    }

    .file-info-path {
      font-size: 0.74rem;
      color: var(--text-dim);
    }

    /* Modal */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeIn 0.2s ease;
    }

    .modal-backdrop.show {
      display: flex;
    }

    .modal-dialog {
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius-lg);
      max-width: 620px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      animation: scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes scaleIn {
      from { transform: scale(0.95); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      gap: 14px;
      background: rgba(239, 68, 68, 0.05);
    }

    .modal-warning-icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--accent-rose-dim);
      color: var(--accent-rose);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .modal-warning-icon svg {
      width: 24px;
      height: 24px;
    }

    .modal-title h3 {
      font-size: 1.15rem;
      font-weight: 700;
    }

    .modal-title p {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .modal-body {
      padding: 24px;
      max-height: 60vh;
      overflow-y: auto;
    }

    .clean-summary-box {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 16px;
      margin-bottom: 18px;
    }

    .summary-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 0.86rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .summary-row:last-child {
      border-bottom: none;
      padding-top: 10px;
      font-weight: 700;
    }

    .file-deletion-list {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--radius-sm);
      padding: 12px;
      max-height: 180px;
      overflow-y: auto;
      font-size: 0.78rem;
    }

    .del-item {
      padding: 4px 0;
      color: #f87171;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .modal-footer {
      padding: 18px 24px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      background: rgba(15, 23, 42, 0.6);
    }

    /* Toast Notification */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .toast {
      background: #1e293b;
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      padding: 14px 20px;
      border-radius: var(--radius-md);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 300px;
      animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .toast.toast-success {
      border-color: rgba(16, 185, 129, 0.4);
    }

    .toast.toast-error {
      border-color: rgba(239, 68, 68, 0.4);
    }

    /* Loading Spinner */
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Empty state */
    .empty-state {
      padding: 48px 20px;
      text-align: center;
      color: var(--text-muted);
    }

    .empty-state svg {
      width: 48px;
      height: 48px;
      color: var(--text-dim);
      margin-bottom: 12px;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
      .path-input-group {
        flex-direction: column;
      }
      .btn {
        width: 100%;
      }
      .group-right {
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
</head>
<body>

  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
        </div>
        <div class="brand-text">
          <h1>StorageAudit Pro</h1>
          <p>Sistem Audit Rekursif & Pembersih Penyimpanan (Node.js Native)</p>
        </div>
      </div>
      <div class="header-badge">
        <div class="status-dot"></div>
        <span>Runtime: Node.js ${process.version} &bull; Port: ${PORT}</span>
      </div>
    </header>

    <!-- Dynamic Control Panel -->
    <div class="control-panel">
      <div class="control-label">
        <span>Target Folder Penyimpanan (Dinamis / Tidak Hardcoded)</span>
        <span id="currentResolvedPath" class="font-mono" style="font-size:0.75rem; text-transform:none;"></span>
      </div>
      <div class="path-input-group">
        <div class="input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
          <input type="text" id="targetPathInput" class="path-input" value="${DEFAULT_TARGET_DIR}" placeholder="Masukkan path folder (contoh: ./Bahan Latihan P12)">
        </div>
        <button id="btnScan" class="btn btn-primary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Pindai Folder</span>
        </button>
        <button id="btnCleanModal" class="btn btn-danger">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>
          <span>Bersihkan Duplikat & Sampah</span>
        </button>
      </div>

      <div class="path-presets">
        <span class="preset-label">Path Cepat:</span>
        <button class="preset-chip" onclick="setPresetPath('./Bahan Latihan P12')">./Bahan Latihan P12 (Default)</button>
        <button class="preset-chip" onclick="setPresetPath('C:/Users/Student/Downloads/Downloads_Lab')">Downloads_Lab (Sumber Asli)</button>
        <button class="preset-chip" onclick="setPresetPath('.')">. (Workspace Root)</button>
        <button class="preset-chip" style="margin-left:auto; background:rgba(16,185,129,0.15); color:#34d399;" onclick="restoreLabData()">Reset / Restore Bahan Uji</button>
      </div>
    </div>

    <!-- 4 Metric Cards -->
    <div class="metrics-grid">
      <!-- Total File -->
      <div class="metric-card card-blue">
        <div class="metric-header">
          <span class="metric-title">Total File</span>
          <div class="metric-icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalFiles">0</div>
        <div class="metric-desc">Semua file dipindai rekursif</div>
      </div>

      <!-- Total Kapasitas -->
      <div class="metric-card card-purple">
        <div class="metric-header">
          <span class="metric-title">Total Kapasitas</span>
          <div class="metric-icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalCapacity">0 MB</div>
        <div class="metric-desc" id="valTotalBytes">0 bytes</div>
      </div>

      <!-- File Raksasa (> 2 MB) -->
      <div class="metric-card card-amber">
        <div class="metric-header">
          <span class="metric-title">File Raksasa</span>
          <div class="metric-icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
        </div>
        <div class="metric-value" id="valGiantFiles">0</div>
        <div class="metric-desc">Ukuran melebihi 2 MB (2.048 KB)</div>
      </div>

      <!-- Potensi Hemat -->
      <div class="metric-card card-emerald">
        <div class="metric-header">
          <span class="metric-title">Potensi Hemat</span>
          <div class="metric-icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
          </div>
        </div>
        <div class="metric-value" id="valPotentialSavings">0 MB</div>
        <div class="metric-desc" id="valRedundantFilesCount">0 salinan kembar</div>
      </div>
    </div>

    <!-- Section Tabs -->
    <div class="section-tabs">
      <button class="tab-btn active" onclick="switchTab('tab-giants')">
        <span>File Raksasa</span>
        <span class="tab-badge" id="badgeGiantsCount">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tab-duplicates')">
        <span>Kelompok Duplikat</span>
        <span class="tab-badge" id="badgeDuplicatesCount">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tab-tmp')">
        <span>File Sampah (.tmp)</span>
        <span class="tab-badge" id="badgeTmpCount">0</span>
      </button>
    </div>

    <!-- TAB 1: File Raksasa -->
    <div id="tab-giants" class="tab-content active">
      <div class="section-card">
        <div class="section-toolbar">
          <div>
            <h2 style="font-size:1.15rem; font-weight:700;">Daftar File Raksasa (&ge; 2 MB / 2.048 KB)</h2>
            <p style="font-size:0.8rem; color:var(--text-muted);">Diurutkan berdasarkan ukuran file terbesar yang memakan kapasitas penyimpanan</p>
          </div>
          <div class="search-input-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="searchGiant" class="search-input" placeholder="Cari file raksasa..." oninput="filterGiantsTable()">
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 50px;">No</th>
                <th>Nama File</th>
                <th>Ukuran (MB)</th>
                <th>Ukuran (KB)</th>
                <th>Path Relatif</th>
                <th>Kategori</th>
              </tr>
            </thead>
            <tbody id="giantTableBody">
              <!-- Render via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: Kelompok Duplikat -->
    <div id="tab-duplicates" class="tab-content">
      <div class="section-card">
        <div class="section-toolbar">
          <div>
            <h2 style="font-size:1.15rem; font-weight:700;">Kelompok File Duplikat (SHA-256 Identik)</h2>
            <p style="font-size:0.8rem; color:var(--text-muted);">Dikelompokkan berdasarkan hash isi file. 1 file orisinil dipertahankan dan sisanya dapat dibersihkan.</p>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
            <button class="btn btn-secondary" style="padding:6px 14px; font-size:0.8rem;" onclick="toggleAllAccordions(true)">Buka Semua</button>
            <button class="btn btn-secondary" style="padding:6px 14px; font-size:0.8rem;" onclick="toggleAllAccordions(false)">Tutup Semua</button>
            <div class="search-input-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" id="searchDups" class="search-input" placeholder="Cari duplikat..." oninput="filterDuplicates()">
            </div>
          </div>
        </div>

        <div class="accordion-list" id="duplicateAccordionList">
          <!-- Render via JS -->
        </div>
      </div>
    </div>

    <!-- TAB 3: File Sampah (.tmp) -->
    <div id="tab-tmp" class="tab-content">
      <div class="section-card">
        <div class="section-toolbar">
          <div>
            <h2 style="font-size:1.15rem; font-weight:700;">File Sampah Sementara (.tmp)</h2>
            <p style="font-size:0.8rem; color:var(--text-muted);">File sementara yang aman untuk dibersihkan secara in-place</p>
          </div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 50px;">No</th>
                <th>Nama File</th>
                <th>Ukuran</th>
                <th>Path Absolut</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="tmpTableBody">
              <!-- Render via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

  <!-- Interactive Confirmation Modal -->
  <div id="confirmModal" class="modal-backdrop">
    <div class="modal-dialog">
      <div class="modal-header">
        <div class="modal-warning-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="modal-title">
          <h3>Konfirmasi Pembersihan In-Place</h3>
          <p>Tindakan ini menghapus file secara permanen di folder target</p>
        </div>
      </div>
      <div class="modal-body">
        <div class="clean-summary-box">
          <div class="summary-row">
            <span style="color:var(--text-muted);">Target Folder:</span>
            <span class="font-mono" id="modalTargetFolder" style="font-weight:600;"></span>
          </div>
          <div class="summary-row">
            <span style="color:var(--text-muted);">Salinan Duplikat Dihapus:</span>
            <span style="color:#f87171;" id="modalRedundantCount">0 file</span>
          </div>
          <div class="summary-row">
            <span style="color:var(--text-muted);">File Asli Dipertahankan:</span>
            <span style="color:#34d399;" id="modalKeptCount">0 file</span>
          </div>
          <div class="summary-row">
            <span style="color:var(--text-muted);">File Sampah (.tmp) Dihapus:</span>
            <span style="color:#f87171;" id="modalTmpCount">0 file</span>
          </div>
          <div class="summary-row">
            <span>Total Ruang Akan Dibebaskan:</span>
            <span style="color:#34d399; font-size:1.05rem;" id="modalSavingsAmount">0 MB</span>
          </div>
        </div>

        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:10px;">
          Daftar file salinan yang akan dieksekusi (dihapus langsung di tempat):
        </p>
        <div class="file-deletion-list" id="modalDeletionPreview">
          <!-- Render list file yang akan dihapus -->
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal()">Batal</button>
        <button id="btnConfirmExecuteClean" class="btn btn-danger">
          <span>Ya, Bersihkan Sekarang</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Container -->
  <div id="toastContainer" class="toast-container"></div>

  <script>
    let currentAuditData = null;

    // Toast utility
    function showToast(message, type = 'success') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.innerHTML = \`
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="\${type === 'success' ? '#10b981' : '#ef4444'}" stroke-width="2">
          \${type === 'success' 
            ? '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' 
            : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
        </svg>
        <div style="font-size:0.88rem; font-weight:500;">\${message}</div>
      \`;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // Set Preset Path
    function setPresetPath(p) {
      document.getElementById('targetPathInput').value = p;
      triggerScan();
    }

    // Tab Switching
    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

      document.getElementById(tabId).classList.add('active');
      const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick').includes(tabId));
      if (activeBtn) activeBtn.classList.add('active');
    }

    // Render Metrics & UI
    function renderAudit(data) {
      currentAuditData = data;
      document.getElementById('currentResolvedPath').textContent = data.resolvedTarget;

      // Update 4 Metrik Cards
      document.getElementById('valTotalFiles').textContent = data.totalFiles.toLocaleString('id-ID');
      document.getElementById('valTotalCapacity').textContent = data.totalCapacityMB;
      document.getElementById('valTotalBytes').textContent = data.totalBytes.toLocaleString('id-ID') + ' bytes';
      document.getElementById('valGiantFiles').textContent = data.giantCount;
      document.getElementById('valPotentialSavings').textContent = data.potentialSavingsMB;
      document.getElementById('valRedundantFilesCount').textContent = data.totalRedundantFiles + ' file duplikat + ' + data.tmpCount + ' file .tmp';

      // Update Tab Badges
      document.getElementById('badgeGiantsCount').textContent = data.giantCount;
      document.getElementById('badgeDuplicatesCount').textContent = data.duplicateGroupCount;
      document.getElementById('badgeTmpCount').textContent = data.tmpCount;

      renderGiantFiles(data.giantFiles);
      renderDuplicateGroups(data.duplicateGroups);
      renderTmpFiles(data.tmpFiles);
    }

    // Render Tabel File Raksasa (15 File)
    function renderGiantFiles(list) {
      const tbody = document.getElementById('giantTableBody');
      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Tidak ada file raksasa (> 2 MB) ditemukan pada folder ini.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map((f, i) => \`
        <tr>
          <td style="color:var(--text-dim); font-weight:600;">\${i + 1}</td>
          <td>
            <div class="file-name-cell">
              <div class="file-type-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              </div>
              <div>
                <div style="font-weight:600; color:#ffffff;">\${f.name}</div>
                <div style="font-size:0.75rem; color:var(--text-dim); font-family:'JetBrains Mono';">\${f.hash.substring(0, 16)}...</div>
              </div>
            </div>
          </td>
          <td style="font-weight:700; color:#fbbf24;">\${f.sizeMB}</td>
          <td class="font-mono" style="color:var(--text-muted); font-size:0.82rem;">\${f.sizeKB}</td>
          <td class="font-mono" style="font-size:0.78rem; color:var(--text-muted); max-width:240px; word-break:break-all;">\${f.relativePath}</td>
          <td>
            <span class="badge badge-giant">&ge; 2 MB</span>
          </td>
        </tr>
      \`).join('');
    }

    function filterGiantsTable() {
      const query = document.getElementById('searchGiant').value.toLowerCase();
      if (!currentAuditData) return;
      const filtered = currentAuditData.giantFiles.filter(f => 
        f.name.toLowerCase().includes(query) || f.relativePath.toLowerCase().includes(query)
      );
      renderGiantFiles(filtered);
    }

    // Render Kelompok Duplikat (20 Grup)
    function renderDuplicateGroups(groups) {
      const container = document.getElementById('duplicateAccordionList');
      if (!groups || groups.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <h3 style="color:#34d399; font-weight:700;">Folder Bersih dari Duplikat!</h3>
            <p style="font-size:0.85rem;">Tidak ditemukan file dengan hash SHA-256 kembar.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = groups.map((g, idx) => \`
        <div class="accordion-item \${idx === 0 ? 'open' : ''}" id="acc-group-\${g.groupId}">
          <div class="accordion-header" onclick="toggleAccordion('acc-group-\${g.groupId}')">
            <div class="group-left">
              <span class="group-number">Grup #\${g.groupId}</span>
              <div class="group-hash">
                <span>SHA-256:</span>
                <code>\${g.shortHash}</code>
              </div>
              <span class="badge badge-neutral">\${g.fileCount} File Identik</span>
            </div>
            <div class="group-right">
              <div style="text-align:right;">
                <div style="font-size:0.85rem; font-weight:700; color:var(--text-main);">\${g.sizeMB} per file</div>
                <div style="font-size:0.75rem; color:#34d399; font-weight:600;">Potensi Hemat: \${g.savingsMB}</div>
              </div>
              <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
          <div class="accordion-body">
            <div class="file-tree">
              \${g.files.map(f => \`
                <div class="file-tree-item \${f.isOriginal ? 'is-original' : 'is-duplicate'}">
                  <div class="file-info-col">
                    <div class="file-info-name" style="color: \${f.isOriginal ? '#ffffff' : '#f87171'};">\${f.name}</div>
                    <div class="file-info-path font-mono">\${f.absolutePath}</div>
                  </div>
                  <div>
                    \${f.isOriginal 
                      ? '<span class="badge badge-original"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ASLI (DIPERTAHANKAN)</span>' 
                      : '<span class="badge badge-duplicate"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> SALINAN KEMBAR (AKAN DIHAPUS)</span>'}
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
        </div>
      \`).join('');
    }

    function toggleAccordion(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }

    function toggleAllAccordions(open) {
      document.querySelectorAll('.accordion-item').forEach(el => {
        if (open) el.classList.add('open');
        else el.classList.remove('open');
      });
    }

    function filterDuplicates() {
      const q = document.getElementById('searchDups').value.toLowerCase();
      if (!currentAuditData) return;
      const filtered = currentAuditData.duplicateGroups.filter(g => 
        g.hash.toLowerCase().includes(q) ||
        g.files.some(f => f.name.toLowerCase().includes(q) || f.absolutePath.toLowerCase().includes(q))
      );
      renderDuplicateGroups(filtered);
    }

    // Render File Sampah
    function renderTmpFiles(list) {
      const tbody = document.getElementById('tmpTableBody');
      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Tidak ada file sampah sementara (.tmp) ditemukan.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map((t, i) => \`
        <tr>
          <td style="color:var(--text-dim); font-weight:600;">\${i+1}</td>
          <td style="font-weight:600; color:#f87171;">\${t.name}</td>
          <td class="font-mono">\${t.sizeKB}</td>
          <td class="font-mono" style="font-size:0.75rem; color:var(--text-muted);">\${t.absolutePath}</td>
          <td><span class="badge badge-duplicate">File Sampah .tmp</span></td>
        </tr>
      \`).join('');
    }

    // Trigger API Scan
    async function triggerScan() {
      const folderPath = document.getElementById('targetPathInput').value.trim();
      const btn = document.getElementById('btnScan');
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div><span>Memindai...</span>';

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
        renderAudit(result.data);
        showToast('Penyimpanan berhasil dipindai! Ditemukan ' + result.data.totalFiles + ' file.');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    }

    // Modal Confirmation Handlers
    document.getElementById('btnCleanModal').addEventListener('click', () => {
      if (!currentAuditData) {
        showToast('Silakan lakukan pemindaian folder terlebih dahulu.', 'error');
        return;
      }

      const redundantCount = currentAuditData.totalRedundantFiles;
      const tmpCount = currentAuditData.tmpCount;
      const totalDeletions = redundantCount + tmpCount;

      if (totalDeletions === 0) {
        showToast('Folder target sudah bersih! Tidak ada file duplikat atau .tmp untuk dibersihkan.', 'success');
        return;
      }

      document.getElementById('modalTargetFolder').textContent = currentAuditData.targetFolder;
      document.getElementById('modalRedundantCount').textContent = redundantCount + ' file';
      document.getElementById('modalKeptCount').textContent = currentAuditData.duplicateGroupCount + ' file';
      document.getElementById('modalTmpCount').textContent = tmpCount + ' file';
      document.getElementById('modalSavingsAmount').textContent = currentAuditData.potentialSavingsMB;

      // Populate file preview deletion list
      const delList = [];
      currentAuditData.duplicateGroups.forEach(g => {
        g.files.forEach(f => {
          if (!f.isOriginal) {
            delList.push({ name: f.name, path: f.absolutePath, type: 'Salinan Duplikat' });
          }
        });
      });
      currentAuditData.tmpFiles.forEach(t => {
        delList.push({ name: t.name, path: t.absolutePath, type: 'File .tmp' });
      });

      document.getElementById('modalDeletionPreview').innerHTML = delList.map(item => \`
        <div class="del-item font-mono">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          <span>[\${item.type}] \${item.name}</span>
        </div>
      \`).join('');

      document.getElementById('confirmModal').classList.add('show');
    });

    function closeModal() {
      document.getElementById('confirmModal').classList.remove('show');
    }

    // Execute Clean In-Place
    document.getElementById('btnConfirmExecuteClean').addEventListener('click', async () => {
      const btn = document.getElementById('btnConfirmExecuteClean');
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div><span>Membersihkan di tempat...</span>';

      try {
        const folderPath = document.getElementById('targetPathInput').value.trim();
        const res = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });
        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Gagal mengeksekusi pembersihan.');
        }

        closeModal();
        renderAudit(result.data.updatedAudit);
        showToast(\`Berhasil membersihkan \${result.data.deletedCount} file! Ruang dibebaskan: \${result.data.freedMB}.\`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    });

    // Reset / Restore Sample Data Helper
    async function restoreLabData() {
      if (!confirm('Apakah Anda ingin mereset/mengembalikan file latihan asli ke folder target?')) return;
      try {
        const folderPath = document.getElementById('targetPathInput').value.trim();
        const res = await fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });
        const r = await res.json();
        if (r.success) {
          showToast('Data latihan berhasil dipulihkan!');
          triggerScan();
        } else {
          showToast(r.error || 'Gagal merestore file latihan', 'error');
        }
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    // Keyboard & Events
    document.getElementById('btnScan').addEventListener('click', triggerScan);
    document.getElementById('targetPathInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') triggerScan();
    });

    // Auto scan saat pertama load
    window.addEventListener('DOMContentLoaded', () => {
      triggerScan();
    });
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
  console.log(`  StorageAudit Pro - Server Berjalan di ${localUrl}`);
  console.log(`  Target Default: ${DEFAULT_TARGET_DIR}`);
  console.log(`  Modul Native Node.js: http, fs, path, crypto (Tanpa npm install)`);
  console.log(`================================================================`);
  openBrowser(localUrl);
});
