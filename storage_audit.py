#!/usr/bin/env python3
"""
StorageAudit Pro - storage_audit.py
Sistem Audit Penyimpanan & Pembersih Duplikat In-Place (Python Native Standard Library)
Menggunakan library bawaan: http.server, os, hashlib, json, webbrowser, shutil
Tanpa perlu pip install apapun.
"""

import os
import sys
import json
import hashlib
import shutil
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

PORT = int(os.environ.get('PORT', 3000))
DEFAULT_TARGET_DIR = './Bahan Latihan P12'
GIANT_THRESHOLD_BYTES = 2048 * 1024  # 2 MB = 2.048 KB = 2,097,152 bytes

def score_originality(filename):
    score = 0
    lower = filename.lower()
    for kw in ['copy', '- copy', '_copy', 'salinan', 'backup', '_backup', 'edit', '(1)', '(2)', '_v2', '_final']:
        if kw in lower:
            score += 1000
    score += len(filename)
    return score

def scan_directory_recursively(dir_path, base_dir=None):
    if base_dir is None:
        base_dir = dir_path
    results = []
    if not os.path.exists(dir_path):
        return results

    try:
        entries = os.scandir(dir_path)
    except Exception as e:
        print(f"Gagal scan folder: {dir_path} - {e}")
        return results

    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            if entry.name in ('.git', 'node_modules', '__pycache__'):
                continue
            results.extend(scan_directory_recursively(entry.path, base_dir))
        elif entry.is_file(follow_symlinks=False):
            try:
                full_path = os.path.abspath(entry.path)
                stat = entry.stat()
                hasher = hashlib.sha256()
                with open(full_path, 'rb') as f:
                    while chunk := f.read(65536):
                        hasher.update(chunk)
                file_hash = hasher.hexdigest()
                rel_path = os.path.relpath(full_path, base_dir).replace('\\', '/')

                results.append({
                    'name': entry.name,
                    'absolutePath': full_path,
                    'relativePath': rel_path,
                    'sizeBytes': stat.st_size,
                    'mtime': stat.st_mtime,
                    'hash': file_hash,
                    'isTmp': entry.name.lower().endswith('.tmp')
                })
            except Exception as err:
                print(f"Gagal membaca file: {entry.path} - {err}")
    return results

def process_audit(target_folder):
    resolved_target = os.path.abspath(target_folder)
    if not os.path.exists(resolved_target):
        raise ValueError(f"Folder target tidak ditemukan: \"{target_folder}\" (Path: {resolved_target})")

    all_files = scan_directory_recursively(resolved_target, resolved_target)
    total_bytes = 0
    hash_map = {}
    giant_files = []
    tmp_files = []

    for f in all_files:
        total_bytes += f['sizeBytes']
        if f['isTmp']:
            tmp_files.append(f)

        if f['sizeBytes'] >= GIANT_THRESHOLD_BYTES:
            giant_files.append({
                'name': f['name'],
                'absolutePath': f['absolutePath'],
                'relativePath': f['relativePath'],
                'sizeBytes': f['sizeBytes'],
                'sizeKB': f"{f['sizeBytes'] / 1024:,.2f} KB".replace(',', 'X').replace('.', ',').replace('X', '.'),
                'sizeMB': f"{f['sizeBytes'] / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.'),
                'hash': f['hash'],
                'isTmp': f['isTmp']
            })

        hash_map.setdefault(f['hash'], []).append(f)

    giant_files.sort(key=lambda x: x['sizeBytes'], reverse=True)

    duplicate_groups = []
    potential_savings_bytes = 0
    total_redundant_files = 0
    group_idx = 1

    for file_hash, file_list in hash_map.items():
        if len(file_list) > 1:
            file_list.sort(key=lambda x: score_originality(x['name']))
            single_size = file_list[0]['sizeBytes']
            redundant_count = len(file_list) - 1
            group_savings = redundant_count * single_size
            potential_savings_bytes += group_savings
            total_redundant_files += redundant_count

            duplicate_groups.append({
                'groupId': group_idx,
                'hash': file_hash,
                'shortHash': file_hash[:10] + '...',
                'fileCount': len(file_list),
                'sizeBytes': single_size,
                'totalSizeBytes': len(file_list) * single_size,
                'sizeKB': f"{single_size / 1024:,.2f} KB".replace(',', 'X').replace('.', ',').replace('X', '.'),
                'sizeMB': f"{single_size / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.'),
                'savingsBytes': group_savings,
                'savingsMB': f"{group_savings / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.'),
                'files': [{
                    'name': fl['name'],
                    'absolutePath': fl['absolutePath'],
                    'relativePath': fl['relativePath'],
                    'sizeBytes': fl['sizeBytes'],
                    'isOriginal': (idx == 0)
                } for idx, fl in enumerate(file_list)]
            })
            group_idx += 1

    for tmp in tmp_files:
        in_dup = any(
            any(f['absolutePath'] == tmp['absolutePath'] and not f['isOriginal'] for f in g['files'])
            for g in duplicate_groups
        )
        if not in_dup:
            potential_savings_bytes += tmp['sizeBytes']

    return {
        'targetFolder': target_folder,
        'resolvedTarget': resolved_target,
        'totalFiles': len(all_files),
        'totalBytes': total_bytes,
        'totalCapacityMB': f"{total_bytes / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.'),
        'giantCount': len(giant_files),
        'giantFiles': giant_files,
        'duplicateGroupCount': len(duplicate_groups),
        'duplicateGroups': duplicate_groups,
        'tmpCount': len(tmp_files),
        'tmpFiles': [{
            'name': t['name'],
            'absolutePath': t['absolutePath'],
            'relativePath': t['relativePath'],
            'sizeBytes': t['sizeBytes'],
            'sizeKB': f"{t['sizeBytes'] / 1024:.2f} KB"
        } for t in tmp_files],
        'totalRedundantFiles': total_redundant_files,
        'potentialSavingsBytes': potential_savings_bytes,
        'potentialSavingsMB': f"{potential_savings_bytes / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.')
    }

def execute_clean_in_place(target_folder):
    audit = process_audit(target_folder)
    deleted_files = []
    freed_bytes = 0
    errors = []

    for group in audit['duplicateGroups']:
        for file_item in group['files']:
            if not file_item['isOriginal']:
                path_to_del = file_item['absolutePath']
                try:
                    if os.path.exists(path_to_del):
                        size = os.path.getsize(path_to_del)
                        os.remove(path_to_del)
                        freed_bytes += size
                        deleted_files.append({
                            'name': file_item['name'],
                            'absolutePath': path_to_del,
                            'type': 'duplikat',
                            'sizeBytes': size
                        })
                except Exception as err:
                    errors.append({'file': path_to_del, 'error': str(err)})

    for tmp in audit['tmpFiles']:
        path_to_del = tmp['absolutePath']
        try:
            if os.path.exists(path_to_del):
                size = os.path.getsize(path_to_del)
                os.remove(path_to_del)
                freed_bytes += size
                deleted_files.append({
                    'name': tmp['name'],
                    'absolutePath': path_to_del,
                    'type': 'sampah_tmp',
                    'sizeBytes': size
                })
        except Exception as err:
            errors.append({'file': path_to_del, 'error': str(err)})

    updated_audit = process_audit(target_folder)
    return {
        'success': True,
        'deletedCount': len(deleted_files),
        'deletedFiles': deleted_files,
        'freedBytes': freed_bytes,
        'freedMB': f"{freed_bytes / (1024*1024):,.2f} MB".replace(',', 'X').replace('.', ',').replace('X', '.'),
        'errors': errors,
        'updatedAudit': updated_audit
    }

def restore_sample_data(target_folder):
    candidates = [
        'C:/Users/Student/Desktop/Downloads_Lab_BACKUP',
        'C:/Users/Student/Desktop/Downloads_Lab',
        'C:/Users/Student/Downloads/Downloads_Lab',
        os.path.join(os.path.dirname(__file__), 'Bahan Latihan P12')
    ]
    lab_source = None
    for c in candidates:
        if os.path.exists(c) and os.path.isdir(c):
            lab_source = c
            break

    if not lab_source:
        return False

    resolved_target = os.path.abspath(target_folder)
    os.makedirs(resolved_target, exist_ok=True)
    for f in os.listdir(lab_source):
        src = os.path.join(lab_source, f)
        dst = os.path.join(resolved_target, f)
        if os.path.isfile(src):
            shutil.copy2(src, dst)
    return True

def resolve_folder_on_disk(folder_name):
    if not folder_name:
        return None
    home = os.path.expanduser('~')
    candidates = [
        os.path.join(home, 'Desktop', folder_name),
        os.path.join(home, 'Downloads', folder_name),
        os.path.join(home, 'Documents', folder_name),
        os.path.join(os.getcwd(), folder_name),
        os.path.join(home, folder_name),
    ]
    for c in candidates:
        if os.path.exists(c) and os.path.isdir(c):
            return os.path.abspath(c)
    return None

def open_os_folder_dialog():
    import subprocess
    if sys.platform == 'win32':
        ps_cmd = 'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = \'Pilih folder target penyimpanan\'; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"'
        p = subprocess.run(ps_cmd, shell=True, capture_output=True, text=True)
        res = p.stdout.strip()
        if res:
            return res
    return None

# Read HTML from storage_audit.js if present, or self-contained template
class AuditHTTPRequestHandler(BaseHTTPRequestHandler):
    def send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/':
            # Serve UI HTML
            js_path = os.path.join(os.path.dirname(__file__), 'storage_audit.js')
            html_content = ""
            if os.path.exists(js_path):
                with open(js_path, 'r', encoding='utf-8') as f:
                    txt = f.read()
                    start = txt.find('<!DOCTYPE html>')
                    end = txt.find('</html>') + 7
                    if start != -1 and end != -1:
                        html_content = txt[start:end]
            if not html_content:
                html_content = "<h1>Storage Audit & Cleaner (Python)</h1><p>UI Template ready</p>"

            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(html_content.encode('utf-8'))
        elif parsed.path == '/api/browse-folder':
            folder = open_os_folder_dialog()
            if folder:
                self.send_json(200, {'success': True, 'folderPath': folder})
            else:
                self.send_json(200, {'success': False, 'error': 'Dibatalkan'})
        else:
            self.send_json(404, {'success': False, 'error': 'Not Found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        target_folder = req_data.get('folderPath', '').strip() or DEFAULT_TARGET_DIR

        if parsed.path == '/api/scan':
            try:
                audit = process_audit(target_folder)
                self.send_json(200, {'success': True, 'data': audit})
            except Exception as e:
                self.send_json(400, {'success': False, 'error': str(e)})

        elif parsed.path == '/api/clean':
            try:
                res = execute_clean_in_place(target_folder)
                self.send_json(200, {'success': True, 'data': res})
            except Exception as e:
                self.send_json(400, {'success': False, 'error': str(e)})

        elif parsed.path == '/api/browse-folder':
            folder = open_os_folder_dialog()
            if folder:
                self.send_json(200, {'success': True, 'folderPath': folder})
            else:
                self.send_json(200, {'success': False, 'error': 'Dibatalkan'})

        elif parsed.path == '/api/resolve-folder':
            fname = req_data.get('folderName', '')
            found = resolve_folder_on_disk(fname)
            if found:
                self.send_json(200, {'success': True, 'folderPath': found})
            else:
                self.send_json(200, {'success': False, 'message': 'Folder tidak ditemukan otomatis'})

        elif parsed.path == '/api/restore':
            try:
                ok = restore_sample_data(target_folder)
                if ok:
                    self.send_json(200, {'success': True, 'message': 'Data restored'})
                else:
                    self.send_json(400, {'success': False, 'error': 'Backup source not found'})
            except Exception as e:
                self.send_json(400, {'success': False, 'error': str(e)})
        else:
            self.send_json(404, {'success': False, 'error': 'Not Found'})

def main():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, AuditHTTPRequestHandler)
    url = f"http://localhost:{PORT}"
    print("=" * 64)
    print(f"  StorageAudit Pro (Python) - Server di {url}")
    print(f"  Target Default: {DEFAULT_TARGET_DIR}")
    print(f"  Library Bawaan Python: http.server, os, hashlib, json")
    print("=" * 64)
    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
        httpd.server_close()

if __name__ == '__main__':
    main()
