const apiBase = "/cloud/api";
const $ = sel => document.querySelector(sel);

function getUserInfo() {
  try {
    const raw = localStorage.getItem('pincerna_user');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function showUserGreeting() {
  const user = getUserInfo();
  const greetEl = document.getElementById('user-greeting');
  const titleEl = document.getElementById('welcome-title');
  if (user && user.given_name) {
    if (greetEl) greetEl.textContent = 'Hi, ' + user.given_name;
    if (titleEl) titleEl.textContent = 'Hi ' + user.given_name + '!';
  } else if (user && user.name) {
    if (greetEl) greetEl.textContent = 'Hi, ' + user.name.split(' ')[0];
    if (titleEl) titleEl.textContent = 'Hi ' + user.name.split(' ')[0] + '!';
  }
}

function logout() {
  localStorage.removeItem('pincerna_token');
  localStorage.removeItem('pincerna_user');
  window.location.href = 'auth.html';
}

function hidePreloader(delay = 700) {
  const p = document.getElementById('preloader');
  if (!p) return;
  setTimeout(() => {
    p.style.transition = 'opacity 220ms ease';
    p.style.opacity = '0';
    setTimeout(() => { p.style.display = 'none'; }, 240);
  }, delay);
}

function showMessage(msg, level = 'info', timeout = 4000) {
  const t = document.createElement('div');
  t.className = 'toast ' + (level || 'info');
  t.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg);
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300) }, timeout);
}

async function apiFetch(path, opts = {}) {
  const headers = opts.headers || {};
  const token = localStorage.getItem('pincerna_token');
  if (token) headers['Authorization'] = token;
  try {
    const res = await fetch(apiBase + path, { ...opts, headers });
    const txt = await res.text();
    if (typeof txt === 'string' && txt.trim().startsWith('<')) return { error: 'server_returned_html' };
    try { return JSON.parse(txt) } catch (e) { return txt }
  } catch (e) { return { error: e.message } }
}

function showSection(sectionId) {
  ['hero', 'controls', 'files', 'metrics', 'about', 'vpn-panel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));

  if (sectionId === 'home') {
    const hero = document.getElementById('hero');
    const controls = document.getElementById('controls');
    if (hero) hero.style.display = 'block';
    if (controls) controls.style.display = 'block';
    const navHome = document.getElementById('nav-home');
    if (navHome) navHome.classList.add('active');
  } else if (sectionId === 'files') {
    const files = document.getElementById('files');
    if (files) files.style.display = 'block';
    const navFiles = document.getElementById('nav-files');
    if (navFiles) navFiles.classList.add('active');
  } else if (sectionId === 'about') {
    const about = document.getElementById('about');
    if (about) about.style.display = 'block';
    const navAbout = document.getElementById('nav-about');
    if (navAbout) navAbout.classList.add('active');
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function loadMetrics() {
  try {
    const res = await apiFetch('/metrics');
    if (res && res.cpu !== undefined) {
            const cpuEl = document.getElementById('metric-cpu');
      const cpuTempEl = document.getElementById('metric-cpu-temp');
      if (cpuEl) cpuEl.textContent = res.cpu + '%';
      if (cpuTempEl) cpuTempEl.textContent = res.cpu_temp ? `${res.cpu_temp}°C` : '';

            const memEl = document.getElementById('metric-memory');
      const memDetailEl = document.getElementById('metric-memory-detail');
      if (memEl) memEl.textContent = res.memory + '%';
      if (memDetailEl && res.memory_used && res.memory_total) {
        memDetailEl.textContent = `${formatBytes(res.memory_used)} / ${formatBytes(res.memory_total)}`;
      }

            const diskEl = document.getElementById('metric-disk');
      const diskDetailEl = document.getElementById('metric-disk-detail');
      if (diskEl) diskEl.textContent = res.disk + '%';
      if (diskDetailEl && res.disk_used && res.disk_total) {
        diskDetailEl.textContent = `${formatBytes(res.disk_used)} / ${formatBytes(res.disk_total)}`;
      }

            const netEl = document.getElementById('metric-network');
      const netDetailEl = document.getElementById('metric-network-detail');
      if (netEl && res.net_recv !== undefined) {
        netEl.textContent = formatBytes(res.net_recv);
      }
      if (netDetailEl && res.net_sent !== undefined) {
        netDetailEl.textContent = `↑ ${formatBytes(res.net_sent)}`;
      }

            const uptimeEl = document.getElementById('metric-uptime');
      const loadEl = document.getElementById('metric-load');
      if (uptimeEl && res.uptime) uptimeEl.textContent = formatUptime(res.uptime);
      if (loadEl && res.load_avg) loadEl.textContent = `Load: ${res.load_avg.join(', ')}`;

            const procEl = document.getElementById('metric-processes');
      const coresEl = document.getElementById('metric-cores');
      if (procEl && res.process_count) procEl.textContent = res.process_count;
      if (coresEl && res.cpu_count) coresEl.textContent = `${res.cpu_count} cores`;

            const lastUpdate = document.getElementById('metrics-last-update');
      if (lastUpdate) lastUpdate.textContent = `Updated: ${new Date().toLocaleTimeString()}`;

            const metricsSection = document.getElementById('metrics');
      if (metricsSection) metricsSection.style.display = 'block';
    }
  } catch (e) {
    showMessage('Failed to load metrics', 'error');
  }
}

let vpnConnected = false;

async function checkVPNStatus() {
  try {
    const res = await apiFetch('/vpn/status');
    if (res && res.connected !== undefined) {
      vpnConnected = res.connected;
      updateVPNUI(res.connected);
    }
  } catch (e) {}
}

async function getVPNStats() {
  try {
    const res = await apiFetch('/vpn/stats');
    if (res) {
            const peersEl = document.getElementById('vpn-peers');
      const rxEl = document.getElementById('vpn-rx');
      const txEl = document.getElementById('vpn-tx');
      
      if (peersEl) peersEl.textContent = res.peer_count || 0;
      if (rxEl) rxEl.textContent = formatBytes(res.transfer_rx || 0);
      if (txEl) txEl.textContent = formatBytes(res.transfer_tx || 0);
    }
  } catch (e) {}
}

function updateVPNUI(connected) {
  const btn = document.getElementById('btn-vpn');
  const indicator = document.getElementById('vpn-indicator');
  const statusText = document.getElementById('vpn-status-text');
  const vpnPanel = document.getElementById('vpn-panel');
  
  if (btn) {
    if (connected) {
      btn.textContent = 'VPN Connected ✓';
      btn.classList.add('active');
      btn.style.background = '#22c55e';
    } else {
      btn.textContent = 'Start VPN';
      btn.classList.remove('active');
      btn.style.background = '';
    }
  }
  
  if (indicator) {
    indicator.className = 'vpn-status-indicator ' + (connected ? 'connected' : 'disconnected');
  }
  if (statusText) {
    statusText.textContent = connected ? 'Connected' : 'Disconnected';
  }
  
    if (vpnPanel) {
    vpnPanel.style.display = connected ? 'block' : 'none';
    if (connected) getVPNStats();
  }
}

async function toggleVPN() {
  const btn = document.getElementById('btn-vpn');
  if (btn) btn.textContent = vpnConnected ? 'Disconnecting...' : 'Connecting...';
  
  try {
    const res = await apiFetch('/vpn/toggle', { method: 'POST' });
    if (res && res.connected !== undefined) {
      vpnConnected = res.connected;
      updateVPNUI(res.connected);
      showMessage(res.message || (res.connected ? 'VPN connected' : 'VPN disconnected'), 'info');
      if (res.connected) getVPNStats();
    } else if (res && res.error) {
      showMessage(res.error, 'error');
      checkVPNStatus();
    }
  } catch (e) {
    showMessage('VPN toggle failed', 'error');
    checkVPNStatus();
  }
}

let currentPath = '/';
let selectedFile = null;

async function listFiles(path = currentPath) {
  currentPath = path;
  const q = '?path=' + encodeURIComponent(path);
  const res = await apiFetch('/files' + q);
  const pathEl = document.getElementById('files-path');
  if (pathEl) pathEl.textContent = path;
  return res;
}

function getFileIcon(name, isDir) {
  if (isDir) return '🗎';
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
  'pdf': '⌘',      
  'doc': '≡',
  'docx': '≡',
  'txt': '⎘',
  'md': '✎',

  'jpg': '▣',
  'jpeg': '▣',
  'png': '▣',
  'gif': '▣',
  'svg': '▣',
  'webp': '▣',

  'mp3': '♪',
  'wav': '♪',
  'flac': '♪',
  'ogg': '♪',

  'mp4': '▶',
  'mkv': '▶',
  'avi': '▶',
  'mov': '▶',
  'webm': '▶',

  'zip': '⬚',
  'rar': '⬚',
  '7z': '⬚',
  'tar': '⬚',
  'gz': '⬚',

  'js': '{}',
  'py': 'λ',
  'html': '<>',
  'css': '#',
  'json': '⋯',

  'exe': '⚙',
  'sh': '⚙',
  'bat': '⚙'
}
;
  return icons[ext] || '🗎';
}

function renderFileList(items, path) {
  const out = document.getElementById('file-list');
  out.innerHTML = '';

    if (path && path !== '/') {
    const upDiv = document.createElement('div');
    upDiv.className = 'file-entry file-dir';
    upDiv.innerHTML = `
      <div class="file-info">
        <span class="file-icon">🗎</span>
        <div class="file-details">
          <div class="file-name">..</div>
          <div class="file-meta">Parent directory</div>
        </div>
      </div>
    `;
    upDiv.addEventListener('click', () => {
      const parent = path.split('/').slice(0, -1).join('/') || '/';
      listFiles(parent).then(res => { if (res && res.files) renderFileList(res.files, parent); });
    });
    out.appendChild(upDiv);
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    if (path === '/') out.innerHTML += '<div class="file-entry"><div class="file-info"><span class="file-icon">🗐</span><div class="file-details"><div class="file-name">Empty folder</div></div></div></div>';
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'file-entry' + (item.is_dir ? ' file-dir' : '');
    div.dataset.path = item.path;
    div.dataset.name = item.name;
    div.dataset.isDir = item.is_dir;

    const icon = getFileIcon(item.name, item.is_dir);
    
    div.innerHTML = `
      <div class="file-info">
        <span class="file-icon">${icon}</span>
        <div class="file-details">
          <div class="file-name">${item.name}</div>
          <div class="file-meta">${item.size || ''} ${item.size && item.mtime ? '•' : ''} ${item.mtime || ''}</div>
        </div>
      </div>
      <div class="actions">
        ${!item.is_dir ? '<button class="btn btn-download" title="Download">⤓</button>' : ''}
        <button class="btn btn-rename" title="Rename">✎</button>
        <button class="btn btn-delete warn" title="Delete">⌫</button>
      </div>
    `;

    if (item.is_dir) {
      div.addEventListener('click', (e) => {
        if (e.target.closest('.actions')) return;
        listFiles(item.path).then(res => { if (res && res.files) renderFileList(res.files, item.path); });
      });
    }

        const downloadBtn = div.querySelector('.btn-download');
    const renameBtn = div.querySelector('.btn-rename');
    const deleteBtn = div.querySelector('.btn-delete');

    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(apiBase + '/files/download?path=' + encodeURIComponent(item.path), '_blank');
      });
    }

    if (renameBtn) {
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameFile(item);
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(item);
      });
    }

        div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, item);
    });

    out.appendChild(div);
  });
}

function showContextMenu(e, item) {
  selectedFile = item;
  const menu = document.getElementById('file-context-menu');
  if (!menu) return;
  
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

    const downloadItem = document.getElementById('ctx-download');
  if (downloadItem) downloadItem.style.display = item.is_dir ? 'none' : 'flex';
}

function hideContextMenu() {
  const menu = document.getElementById('file-context-menu');
  if (menu) menu.style.display = 'none';
}

async function deleteFile(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  const res = await apiFetch('/files?path=' + encodeURIComponent(item.path), { method: 'DELETE' });
  if (res && res.success) {
    showMessage(`Deleted "${item.name}"`, 'info');
    refreshFiles();
  } else {
    showMessage(res.error || 'Delete failed', 'error');
  }
}

function renameFile(item) {
  const newName = prompt('Enter new name:', item.name);
  if (!newName || newName === item.name) return;
  
    renameFileAPI(item.path, newName);
}

async function renameFileAPI(oldPath, newName) {
  const res = await apiFetch('/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: oldPath, new_name: newName })
  });
  if (res && res.success) {
    showMessage('Renamed successfully', 'info');
    refreshFiles();
  } else {
    showMessage(res.error || 'Rename failed', 'error');
  }
}

async function createFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  
  const res = await apiFetch('/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, name: name })
  });
  if (res && res.success) {
    showMessage(`Created folder "${name}"`, 'info');
    refreshFiles();
  } else {
    showMessage(res.error || 'Failed to create folder', 'error');
  }
}

async function moveFile(item, destPath) {
  const res = await apiFetch('/files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: item.path, destination: destPath })
  });
  if (res && res.success) {
    showMessage(`Moved "${item.name}"`, 'info');
    refreshFiles();
  } else {
    showMessage(res.error || 'Move failed', 'error');
  }
}

async function uploadFile(file) {
  const progressDiv = document.getElementById('upload-progress');
  const progressFill = document.getElementById('upload-fill');
  const statusText = document.getElementById('upload-status');
  
  if (progressDiv) progressDiv.style.display = 'block';
  if (statusText) statusText.textContent = `Uploading ${file.name}...`;
  if (progressFill) progressFill.style.width = '0%';
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('path', currentPath);
  
  try {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && progressFill) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = percent + '%';
        if (statusText) statusText.textContent = `Uploading ${file.name}... ${percent}%`;
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        if (statusText) statusText.textContent = `Uploaded ${file.name} ✓`;
        setTimeout(() => {
          if (progressDiv) progressDiv.style.display = 'none';
        }, 2000);
        refreshFiles();
      } else {
        if (statusText) statusText.textContent = `Upload failed`;
        showMessage('Upload failed', 'error');
      }
    });
    
    xhr.addEventListener('error', () => {
      if (statusText) statusText.textContent = `Upload error`;
      showMessage('Upload failed', 'error');
    });
    
    const token = localStorage.getItem('pincerna_token');
    xhr.open('POST', apiBase + '/files/upload');
    if (token) xhr.setRequestHeader('Authorization', token);
    xhr.send(formData);
    
  } catch (e) {
    showMessage('Upload failed: ' + e.message, 'error');
    if (progressDiv) progressDiv.style.display = 'none';
  }
}

async function refreshFiles() {
  const res = await listFiles(currentPath);
  if (res && res.files) renderFileList(res.files, currentPath);
  else if (res && res.error === 'server_returned_html') showMessage('Backend not connected', 'error');
  else if (res && res.error) showMessage(res.error, 'error');
  return res;
}

document.addEventListener('DOMContentLoaded', () => {
  showSection('home');
  showUserGreeting();

  const indicator = document.getElementById('preloader-indicator');
  if (indicator) indicator.textContent = 'Connecting...';

    if (!localStorage.getItem('pincerna_token')) {
    window.location.href = 'auth.html';
    return;
  }

    $('#btn-logout').addEventListener('click', logout);
  $('#btn-vpn').addEventListener('click', toggleVPN);
  $('#btn-access-local').addEventListener('click', () => { document.getElementById('nav-files').click(); });

    const btnMetrics = document.getElementById('btn-metrics');
  if (btnMetrics) btnMetrics.addEventListener('click', loadMetrics);

    const btnRefreshMetrics = document.getElementById('btn-refresh-metrics');
  if (btnRefreshMetrics) btnRefreshMetrics.addEventListener('click', loadMetrics);

    const btnRestart = document.getElementById('btn-restart');
  if (btnRestart) {
    btnRestart.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to restart the service?')) return;
      const res = await apiFetch('/restart', { method: 'POST' });
      if (res && res.error) showMessage(res.error, 'error');
      else showMessage('Restart command sent', 'info');
    });
  }

    $('#nav-home').addEventListener('click', (e) => { e.preventDefault(); showSection('home'); });
  $('#nav-files').addEventListener('click', (e) => { e.preventDefault(); showSection('files'); refreshFiles(); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); showSection('about'); });

    const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (ev) => {
      const files = ev.target.files;
      for (let i = 0; i < files.length; i++) {
        uploadFile(files[i]);
      }
      fileInput.value = '';
    });
  }

    const btnNewFolder = document.getElementById('btn-new-folder');
  if (btnNewFolder) btnNewFolder.addEventListener('click', createFolder);

    const btnRefreshFiles = document.getElementById('btn-refresh-files');
  if (btnRefreshFiles) btnRefreshFiles.addEventListener('click', refreshFiles);

    document.addEventListener('click', hideContextMenu);
  
  const ctxDownload = document.getElementById('ctx-download');
  const ctxRename = document.getElementById('ctx-rename');
  const ctxDelete = document.getElementById('ctx-delete');
  const ctxMove = document.getElementById('ctx-move');

  if (ctxDownload) {
    ctxDownload.addEventListener('click', () => {
      if (selectedFile && !selectedFile.is_dir) {
        window.open(apiBase + '/files/download?path=' + encodeURIComponent(selectedFile.path), '_blank');
      }
      hideContextMenu();
    });
  }

  if (ctxRename) {
    ctxRename.addEventListener('click', () => {
      if (selectedFile) renameFile(selectedFile);
      hideContextMenu();
    });
  }

  if (ctxDelete) {
    ctxDelete.addEventListener('click', () => {
      if (selectedFile) deleteFile(selectedFile);
      hideContextMenu();
    });
  }

  if (ctxMove) {
    ctxMove.addEventListener('click', () => {
      if (selectedFile) {
        const dest = prompt('Move to (full path):', '/');
        if (dest) moveFile(selectedFile, dest);
      }
      hideContextMenu();
    });
  }

    fetch(apiBase + '/health').then(r => {
    if (r.ok) {
      hidePreloader(300);
    } else {
      if (indicator) indicator.textContent = 'Backend unavailable';
      hidePreloader(1500);
    }
  }).catch(() => {
    if (indicator) indicator.textContent = 'Cannot connect to server';
    hidePreloader(1500);
  });

    checkVPNStatus();
  
    setInterval(() => {
    if (vpnConnected) getVPNStats();
  }, 30000);
});
