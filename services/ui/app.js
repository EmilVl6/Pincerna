const apiBase = "/cloud/api";
const $ = sel => document.querySelector(sel);

// Video modal global (exposed on window to avoid ReferenceErrors from
// different bundle scopes or stale cached scripts)
window.currentVideo = null;

// API fetch wrapper that adds auth token
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('pincerna_token');
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = token;
  }
  const fullUrl = url.startsWith('http') ? url : apiBase + url;
  const response = await fetch(fullUrl, { ...options, headers });
  if (response.status === 401) {
    // Token invalid, redirect to auth
    localStorage.removeItem('pincerna_token');
    localStorage.removeItem('pincerna_user');
    window.location.href = 'auth.html';
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      throw new Error(json.error || 'API error');
    } catch {
      throw new Error(text || 'API error');
    }
  }
  return response.json();
}

// Streaming UI globals (ensure safe defaults so older or partial bundles
// don't cause runtime ReferenceErrors).
var STREAM_FILES = [];
var STREAM_OFFSET = 0;
var STREAM_BATCH = 24; // number of items to render per batch
var STREAM_THUMB_OBSERVER = null;
var STREAM_SENTINEL_OBSERVER = null;

function getUserInfo() {
  try {
    const raw = localStorage.getItem('pincerna_user');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function showUserGreeting() {
  const info = getUserInfo();
  const el = document.getElementById('user-greeting');
  if (!el) return;
  if (info) {
    // Prefer first name only (e.g. "Emil"). Fall back to a friendly default.
    let name = null;
    if (info.name) name = String(info.name).split(' ')[0];
    else if (info.email) name = String(info.email).split('@')[0];
    if (!name) name = 'Emil';
    el.textContent = `Hi ${name}`;
  } else {
    el.textContent = '';
  }
}

async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (e) {
    // ignore network errors during logout
  }
  localStorage.removeItem('pincerna_token');
  localStorage.removeItem('pincerna_user');
  window.location.href = 'auth.html';
}

async function loadStreamingFiles() {
  const filesEl = document.getElementById('streaming-files');
  if (!filesEl) return;
  try {
    // Fetch indexed video files from the background indexer
    const apiUrl = window.location.origin + '/cloud/api/streaming/index';
    let res = await fetch(apiUrl);
    if (!res.ok) {
      console.error('Fetch failed:', res.status, res.statusText);
      const text = await res.text();
      console.error('Response:', text);
      showMessage('Failed to load Streaming folder: ' + res.status, 'error');
      filesEl.innerHTML = '';
      return;
    }
    res = await res.json();
    // Filter out duplicates based on path
    if (res.files) {
      res.files = res.files.filter((f, i, arr) => arr.findIndex(x => x.path === f.path) === i);
    }

    // Cache a lightweight copy of the indexed files so we can show a default
    // gallery if searches or reloads temporarily return no results.
    try {
      const cached = (res.files || []).map(f => ({ path: f.path, name: f.name, thumbnail: f.thumbnail, size: f.size }));
      localStorage.setItem('pincerna_last_stream_files', JSON.stringify(cached.slice(0, 200)));
    } catch (e) {}

    if (res && res.files) {
    // replace heavy background-image approach with incremental rendering + <img loading="lazy">
    // Include all indexed files so videos without thumbnails are still shown
    STREAM_FILES = (res.files || []).filter(f => f);
      STREAM_OFFSET = 0;

      filesEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input id="stream-search" placeholder="Search" style="flex:1;padding:8px;border:1px solid rgba(0,0,0,0.06)">
        </div>
        <div id="stream-grid" class="stream-grid"></div>
        <div id="stream-sentinel" style="height:1px"></div>
      `;

      const search = document.getElementById('stream-search');
      const grid = document.getElementById('stream-grid');
      const sentinel = document.getElementById('stream-sentinel');

      function setupThumbObserver() {
        if (STREAM_THUMB_OBSERVER) return;
        STREAM_THUMB_OBSERVER = new IntersectionObserver((entries, obs) => {
          entries.forEach(en => {
            if (!en.isIntersecting) return;
            const img = en.target;
            const src = img.dataset && img.dataset.src;
            if (src && !img.src) {
              img.src = src;
              img.addEventListener('error', () => img.classList.add('thumb-error'));
            }
            obs.unobserve(img);
          });
        }, { rootMargin: '200px' });
      }

      function setupSentinelObserver() {
        if (STREAM_SENTINEL_OBSERVER) return;
        STREAM_SENTINEL_OBSERVER = new IntersectionObserver((entries) => {
          entries.forEach(en => {
            if (en.isIntersecting) {
              renderNextBatch();
            }
          });
        }, { rootMargin: '400px' });
        if (sentinel) STREAM_SENTINEL_OBSERVER.observe(sentinel);
      }

      function createCard(f) {
        const thumb = f.thumbnail || (window.location.origin + '/cloud/api/thumbnail?path=' + encodeURIComponent(f.path));
        const card = document.createElement('div');
        card.className = 'stream-card';
        card.dataset.path = f.path;
        card.dataset.thumb = thumb || '';
        card.dataset.name = f.name;
        card.tabIndex = 0;

        const banner = document.createElement('div');
        banner.className = 'stream-card-banner';
        const img = document.createElement('img');
        img.className = 'stream-thumb';
        img.alt = f.name;
        img.loading = 'lazy';
        img.dataset.src = thumb;
        // Placeholder for failed thumbnails: replace <img> with styled placeholder
        img.addEventListener('error', () => {
          const ph = document.createElement('div');
          ph.className = 'thumb-placeholder';
          ph.textContent = 'No Thumbnail';
          if (img.parentNode) img.parentNode.replaceChild(ph, img);
        });
        banner.appendChild(img);

        // Hidden preview element to warm up playback on hover/focus
        const previewUrl = window.location.origin + '/cloud/api/files/preview?path=' + encodeURIComponent(f.path) + '&token=' + encodeURIComponent(localStorage.getItem('pincerna_token') || '');
        const pre = document.createElement('video');
        pre.className = 'preview-preload';
        pre.preload = 'metadata';
        pre.muted = true;
        pre.playsInline = true;
        pre.style.display = 'none';
        pre.dataset.src = previewUrl;
        banner.appendChild(pre);
        // overlay with title (play button removed)
        const overlay = document.createElement('div');
        overlay.className = 'poster-overlay';
        banner.appendChild(overlay);

        const title = document.createElement('div');
        title.className = 'overlay-title';
        title.textContent = f.name;

        overlay.appendChild(title);

        card.appendChild(banner);

        card.addEventListener('click', async (e) => {
          // single-click selects and opens the player
          selectCardByElement(card);
          if (window.currentVideo) {
            window.currentVideo.pause();
            window.currentVideo.currentTime = 0;
          }
          const video = document.getElementById('modal-video');
          const img = card.querySelector('.stream-thumb');
          const thumbUrl = img ? img.src : '';
          video.poster = thumbUrl;
          video.preload = 'metadata';
          const previewUrl = window.location.origin + '/cloud/api/files/preview?path=' + encodeURIComponent(card.dataset.path) + '&token=' + encodeURIComponent(localStorage.getItem('pincerna_token') || '') + '&raw=1';
          video.src = previewUrl;
          video.load();
          video.play();
          document.getElementById('video-modal').style.display = 'flex';
          window.currentVideo = video;
          // Buffer indication
          const bufferInfo = document.getElementById('buffer-info');
          bufferInfo.textContent = 'Loading...';
          video.addEventListener('progress', () => {
            const buffered = video.buffered;
            if (buffered.length > 0 && video.duration) {
              const bufferedEnd = buffered.end(buffered.length - 1);
              const percent = (bufferedEnd / video.duration) * 100;
              bufferInfo.textContent = `Buffered: ${percent.toFixed(1)}%`;
            }
          });
          video.addEventListener('canplay', () => {
            bufferInfo.textContent = 'Ready to play';
          });
        });
        // Pop-out removed — no handler needed
        // preload when the user hovers or focuses the card (warm up first frame)
        const startPreload = () => {
          try {
            if (pre.dataset.loaded) return;
            pre.src = pre.dataset.src || previewUrl;
            pre.load();
            pre.dataset.loaded = '1';
          } catch (e) {}
        };
        card.addEventListener('mouseenter', startPreload);
        card.addEventListener('focus', startPreload);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
          }
        });

        return { card, img };
      }

      // Selection handling and keyboard navigation
      let SELECTED_INDEX = -1;
      function getAllCards() {
        return Array.from(grid.querySelectorAll('.stream-card'));
      }
      function selectCard(idx) {
        const cards = getAllCards();
        if (!cards.length) return;
        if (idx < 0) idx = 0;
        if (idx >= cards.length) idx = cards.length - 1;
        cards.forEach(c => c.classList.remove('selected'));
        const card = cards[idx];
        if (!card) return;
        card.classList.add('selected');
        SELECTED_INDEX = idx;
        // ensure visible
        card.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'center'});
        try { card.focus(); } catch(e){}
      }
      function selectCardByElement(el) {
        const cards = getAllCards();
        const idx = cards.indexOf(el);
        if (idx !== -1) selectCard(idx);
      }
      function moveSelection(dx, dy) {
        const cards = getAllCards();
        if (!cards.length) return;
        const cardWidth = (cards[0] && cards[0].getBoundingClientRect().width) || 220;
        const cols = Math.max(1, Math.floor(grid.clientWidth / Math.max(200, cardWidth)));
        let idx = SELECTED_INDEX;
        if (idx === -1) idx = 0;
        if (dx === 1) idx = Math.min(cards.length-1, idx+1);
        if (dx === -1) idx = Math.max(0, idx-1);
        if (dy === 1) idx = Math.min(cards.length-1, idx+cols);
        if (dy === -1) idx = Math.max(0, idx-cols);
        selectCard(idx);
      }
      document.addEventListener('keydown', (e) => {
        if (document.getElementById('streaming-player-modal')) return; // don't navigate while player is open
        if (['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'].includes(e.key)) {
          e.preventDefault();
          if (e.key === 'ArrowRight') moveSelection(1,0);
          if (e.key === 'ArrowLeft') moveSelection(-1,0);
          if (e.key === 'ArrowDown') moveSelection(0,1);
          if (e.key === 'ArrowUp') moveSelection(0,-1);
        }
        if (e.key === 'Enter') {
          const cards = getAllCards();
          if (SELECTED_INDEX >=0 && SELECTED_INDEX < cards.length) cards[SELECTED_INDEX].click();
        }
      });

      function renderNextBatch() {
        if (!grid) return;
        const start = STREAM_OFFSET;
        const end = Math.min(STREAM_FILES.length, STREAM_OFFSET + STREAM_BATCH);
        const slice = STREAM_FILES.slice(start, end);
        if (slice.length === 0) {
          // nothing left; disconnect sentinel
          if (STREAM_SENTINEL_OBSERVER && sentinel) STREAM_SENTINEL_OBSERVER.unobserve(sentinel);
          return;
        }
        STREAM_OFFSET = end;
        setupThumbObserver();
        slice.forEach(f => {
          const { card, img } = createCard(f);
          grid.appendChild(card);
          if (img && STREAM_THUMB_OBSERVER) STREAM_THUMB_OBSERVER.observe(img);
        });
        // if there are still items, ensure sentinel is observed
        if (STREAM_OFFSET < STREAM_FILES.length) setupSentinelObserver();
      }

      // reset grid when searching
      function resetStreamGrid(list) {
        // If the incoming list is empty, try fallbacks: current server response
        // (res.files) or a locally cached last-known set so the UI doesn't
        // become just a title + search bar.
        if (!list || list.length === 0) {
          let fallback = (res && res.files) ? (res.files || []) : [];
          // prefer items with thumbnails
          fallback = fallback.filter(f => f && f.thumbnail);
          if (!fallback || fallback.length === 0) {
            try {
              const cached = JSON.parse(localStorage.getItem('pincerna_last_stream_files') || '[]');
              if (Array.isArray(cached) && cached.length) fallback = cached;
            } catch (e) { fallback = []; }
          }
          // still empty -> show friendly empty state and return
          if (!fallback || fallback.length === 0) {
            STREAM_FILES = [];
            STREAM_OFFSET = 0;
            grid.innerHTML = '<div style="padding:18px;color:rgba(255,255,255,0.7);">No results found. Try clearing the search or <a id="stream-show-all" href="#">show all</a>.</div>';
            const showAll = document.getElementById('stream-show-all');
            if (showAll) showAll.addEventListener('click', (ev) => { ev.preventDefault(); resetStreamGrid(res.files || []); });
            return;
          }
          list = fallback;
        }
        STREAM_FILES = list;
        STREAM_OFFSET = 0;
        grid.innerHTML = '';
        if (STREAM_SENTINEL_OBSERVER && sentinel) STREAM_SENTINEL_OBSERVER.observe(sentinel);
        renderNextBatch();
      }

      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        if (!q) return resetStreamGrid(res.files || []);
        const filtered = (res.files || []).filter(f => (f.name || '').toLowerCase().includes(q));
        resetStreamGrid(filtered);
      });

      // initial render (first batch)
      renderNextBatch();

      // try to pre-observe sentinel for infinite scroll
      setupSentinelObserver();

      // hide preloader as soon as first batch is appended
      hidePreloader(400);
    } else if (res && res.error) {
      filesEl.innerHTML = '';
      showMessage('Failed to list Streaming folder: ' + res.error, 'error');
    }
  } catch (e) {
    showMessage('Failed to load Streaming folder', 'error');
  }
}
function showSection(sectionId) {
  ['hero', 'controls', 'files', 'metrics', 'about', 'streaming-panel'].forEach(id => {
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
  } else if (sectionId === 'streaming') {
    const streamingPanel = document.getElementById('streaming-panel');
    if (streamingPanel) streamingPanel.style.display = 'block';
    const navStreaming = document.getElementById('nav-streaming');
    if (navStreaming) navStreaming.classList.add('active');
    loadStreamingPanel();
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

function downloadFile(item) {
  const token = localStorage.getItem('pincerna_token');
  if (!token) {
    showMessage('Not authenticated', 'error');
    return;
  }
  
  showMessage(`Downloading ${item.name}`, 'info', 3000);
  
  const downloadUrl = apiBase + '/files/download?path=' + encodeURIComponent(item.path);
  
  fetch(downloadUrl, {
    method: 'GET',
    headers: {
      'Authorization': token
    }
  })
  .then(response => {
    if (!response.ok) {
      return response.json().then(err => { throw new Error(err.error || 'Download failed'); });
    }
    return response.blob();
  })
  .then(blob => {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = item.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    showMessage(`Downloaded ${item.name}`, 'info', 2000);
  })
  .catch(err => {
    showMessage('Download failed: ' + err.message, 'error');
  });
}

function previewFile(item) {
  const token = localStorage.getItem('pincerna_token');
  if (!token) {
    showMessage('Not authenticated', 'error');
    return;
  }
  
  const previewUrl = apiBase + '/files/preview?path=' + encodeURIComponent(item.path) + '&token=' + encodeURIComponent(token);
  window.open(previewUrl, '_blank');
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
let vpnConfigured = true;

async function checkVPNStatus() {
  try {
    const res = await apiFetch('/vpn/status');
    if (res && res.connected !== undefined) {
      vpnConnected = res.connected;
      vpnConfigured = res.config_exists !== false;
      updateVPNUI(res.connected, res);
      if (res.connected) getVPNStats();
    } else if (res && res.error) {
      vpnConnected = false;
      updateVPNUI(false, { error: res.error });
    }
  } catch (e) {
    updateVPNUI(false, { error: 'Failed to check VPN status' });
  }
}

async function getVPNStats() {
  return;
}


let networkDevices = [];
let isScanning = false;
let deviceNicknames = {};
let networkGateway = '';

function loadDeviceNicknames() {
  try {
    const saved = localStorage.getItem('pincerna_device_nicknames');
    if (saved) deviceNicknames = JSON.parse(saved);
  } catch (e) {}
}

function saveDeviceNicknames() {
  try {
    localStorage.setItem('pincerna_device_nicknames', JSON.stringify(deviceNicknames));
  } catch (e) {}
}

function saveNetworkState() {
  try {
    sessionStorage.setItem('pincerna_network_devices', JSON.stringify(networkDevices));
    sessionStorage.setItem('pincerna_network_gateway', networkGateway);
  } catch (e) {}
}

function restoreNetworkState() {
  try {
    const devices = sessionStorage.getItem('pincerna_network_devices');
    const gateway = sessionStorage.getItem('pincerna_network_gateway');
    if (devices) networkDevices = JSON.parse(devices);
    if (gateway) networkGateway = gateway;
    return networkDevices.length > 0;
  } catch (e) {
    return false;
  }
}

function getDeviceDisplayName(device) {
  return deviceNicknames[device.ip] || device.hostname || device.ip;
}

function setDeviceNickname(ip, nickname) {
  if (nickname && nickname.trim()) {
    deviceNicknames[ip] = nickname.trim();
  } else {
    delete deviceNicknames[ip];
  }
  saveDeviceNicknames();
}

loadDeviceNicknames();

async function scanNetwork() {
  if (isScanning) return;
  isScanning = true;
  
  const devicesGrid = document.getElementById('network-devices');
  const scanningEl = document.getElementById('network-scanning');
  const emptyEl = document.getElementById('network-empty');
  const statusDot = document.querySelector('.network-status-dot');
  const statusText = document.getElementById('network-status-text');
  
  if (scanningEl) scanningEl.style.display = 'flex';
  if (emptyEl) emptyEl.style.display = 'none';
  if (devicesGrid) devicesGrid.innerHTML = '';
  if (statusDot) statusDot.classList.add('scanning');
  if (statusText) statusText.textContent = 'Scanning network';
  
  try {
    const res = await apiFetch('/network/scan');
    
    if (res && res.devices) {
      networkDevices = res.devices;
      networkGateway = res.gateway || '';
      saveNetworkState();
      
      if (networkGateway) {
        const gatewayDevice = networkDevices.find(d => d.ip === networkGateway);
        if (gatewayDevice) gatewayDevice.is_gateway = true;
      }
      
      if (statusDot) {
        statusDot.classList.remove('scanning');
        statusDot.classList.add('connected');
      }
      if (statusText) {
        statusText.textContent = `${res.devices.length} devices on ${res.network}`;
      }
      
      if (res.devices.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
      } else {
        renderNetworkDevices(res.devices, networkGateway);
      }
    } else if (res && res.error) {
      showMessage('Network scan failed: ' + res.error, 'error');
      if (statusText) statusText.textContent = 'Scan failed';
      if (statusDot) statusDot.classList.remove('scanning', 'connected');
    }
  } catch (e) {
    showMessage('Network scan failed', 'error');
    if (statusText) statusText.textContent = 'Connection error';
    if (statusDot) statusDot.classList.remove('scanning', 'connected');
  } finally {
    isScanning = false;
    if (scanningEl) scanningEl.style.display = 'none';
  }
}

function renderNetworkDevices(devices, gatewayIp) {
  const grid = document.getElementById('network-devices');
  if (!grid) return;
  
  const sortedDevices = [...devices].sort((a, b) => {
    if (a.ip === gatewayIp) return -1;
    if (b.ip === gatewayIp) return 1;
    if (a.is_server) return -1;
    if (b.is_server) return 1;
    return a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
  
  grid.className = 'network-devices-grid';
  grid.innerHTML = `
    <svg class="grid-lines" id="grid-svg"></svg>
    ${sortedDevices.map(device => {
    const icon = getDeviceIcon(device);
    const isGateway = device.ip === gatewayIp || device.is_gateway;
    const statusClass = device.is_server ? 'server' : (isGateway ? 'gateway' : (device.online ? 'online' : 'offline'));
    const deviceType = device.is_server ? 'This Server' : (isGateway ? 'Router/Gateway' : (device.hostname ? '' : 'Unknown Device'));
    const displayName = getDeviceDisplayName(device);
    const hasNickname = deviceNicknames[device.ip];
    
    return `
      <div class="network-device ${statusClass}" data-ip="${device.ip}" id="grid-device-${device.ip.replace(/\./g, '-')}">
        <div class="device-header">
          <span class="device-icon">${icon}</span>
          <div class="device-header-info">
            <div class="device-name" title="Click to rename">${displayName}</div>
            ${hasNickname ? `<div class="device-hostname">${device.hostname || ''}</div>` : ''}
            ${deviceType ? `<div class="device-type">${deviceType}</div>` : ''}
          </div>
          <button class="device-edit-btn" data-ip="${device.ip}" title="Edit nickname">✎</button>
        </div>
        <div class="device-info">
          <div class="device-ip">${device.ip}</div>
          ${device.mac ? `<div class="device-mac">${device.mac}</div>` : ''}
        </div>
        <div class="device-quick-actions" id="actions-${device.ip.replace(/\./g, '-')}">
          ${renderQuickActions(device)}
        </div>
        <div class="device-services" id="services-${device.ip.replace(/\./g, '-')}">
          ${renderDeviceServices(device)}
        </div>
      </div>
    `;
  }).join('')}
  `;
  
  grid.querySelectorAll('.network-device').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.device-edit-btn') || e.target.closest('.device-quick-actions') || e.target.closest('.device-services')) return;
      const ip = el.dataset.ip;
      scanDevicePorts(ip);
    });
  });
  
  grid.querySelectorAll('.device-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ip = btn.dataset.ip;
      const device = networkDevices.find(d => d.ip === ip);
      const currentName = getDeviceDisplayName(device);
      const newName = prompt('Enter a nickname for this device:', currentName);
      if (newName !== null) {
        setDeviceNickname(ip, newName);
        renderNetworkDevices(networkDevices, networkGateway);
      }
    });
  });
  
  setTimeout(() => drawGridLines(gatewayIp), 100);
}

async function loadStreamingPanel() {
  const filesEl = document.getElementById('streaming-files');
  if (filesEl) filesEl.innerHTML = '';
  loadStreamingFiles();
}

async function listStorageDevices() {
  const devicesEl = document.getElementById('streaming-devices');
  const scanningEl = document.getElementById('streaming-scanning');
  if (scanningEl) scanningEl.style.display = 'flex';
  try {
    const res = await apiFetch('/storage/devices');
    if (res && res.devices) {
      renderFilesStoragePanel(res.devices);
    } else if (res && res.error) {
      showMessage('Storage list failed: ' + res.error, 'error');
    }
  } catch (e) {
    showMessage('Storage list failed', 'error');
  } finally {
    if (scanningEl) scanningEl.style.display = 'none';
  }
}

function renderFilesStoragePanel(devices) {
  const panel = document.getElementById('files-storage-devices');
  if (!panel) return;
  panel.innerHTML = devices.map(d => `
    <div style="padding:8px;border-bottom:1px solid rgba(0,0,0,0.04);display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:600">${d.device || d.mountpoint}</div>
        <div style="font-size:0.85rem;color:#666">${d.mountpoint} • ${formatBytes(d.total)}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="(function(){ const src='${d.mountpoint}'; if(confirm('Backup streaming from ' + src + '?')) { apiFetch('/storage/backup', { method: 'POST', body: JSON.stringify({ source: src }), headers: { 'Content-Type': 'application/json' } }).then(r=>{ if(r && r.success) showMessage('Backup done','info'); else showMessage('Backup failed','error'); }); } })()">Backup</button>
      </div>
    </div>
  `).join('');

  const backupsPanel = document.getElementById('files-backups');
  if (backupsPanel) {
    apiFetch('/files?path=' + encodeURIComponent('/Backups')).then(res => {
      if (res && res.files) {
        backupsPanel.innerHTML = res.files.map(f => `<div style="padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.03)">${f.name}</div>`).join('');
      } else backupsPanel.innerHTML = '<div style="color:#666">No backups</div>';
    });
  }
}




function showStreamingPlayer(path, name) {
  const token = localStorage.getItem('pincerna_token') || '';
  // prefer any preloaded preview element if available
  let src = window.location.origin + '/cloud/api/files/preview?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(token);
  try {
    const preEl = document.querySelector(`.stream-card[data-path="${path}"] video.preview-preload`);
    if (preEl && preEl.src) src = preEl.currentSrc || preEl.src;
  } catch(e){}
  const ext = (name.split('.').pop() || '').toLowerCase();
  const videoExts = ['mp4','webm','ogg','mov'];
  const audioExts = ['mp3','wav','m4a','aac','flac'];

  const existing = document.getElementById('streaming-player-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'streaming-player-modal';
  modal.className = 'streaming-player-modal';
  // find thumbnail from the card if present
  let poster = '';
  try { poster = document.querySelector(`.stream-card[data-path="${path}"]`)?.dataset.thumb || ''; } catch(e){}

  let mediaHtml = '';
  if (videoExts.includes(ext)) {
    mediaHtml = `<video id="pincerna-player" controls playsinline style="width:100%;height:100%" poster="${poster}"><source src="${src}"></video>`;
  } else if (audioExts.includes(ext)) {
    mediaHtml = `<audio id="pincerna-player" controls style="width:100%"><source src="${src}"></audio>`;
  } else {
    mediaHtml = `<div style="padding:12px">Cannot play this file in-browser. <a href="${src}" target="_blank">Open</a></div>`;
  }

  modal.innerHTML = `
    <div class="streaming-player-wrap">
      <div class="streaming-player-header">
        <h1 style="margin:0;font-size:1.6rem">${name}</h1>
        <div class="streaming-player-controls">
          <button id="streaming-full" class="btn">Fullscreen</button>
          <button id="streaming-close" class="btn">Close</button>
        </div>
      </div>
      <div class="streaming-player-body">${mediaHtml}<div id="buffer-info"></div></div>
      <div class="streaming-player-details" style="padding:12px 16px;color:rgba(255,255,255,0.8);font-size:0.95rem">
        <div><strong>Path:</strong> ${path}</div>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  function closeModal() {
    try { const p = document.getElementById('pincerna-player'); if (p && !p.paused) p.pause(); } catch(e){}
    // Deselect all stream cards
    const cards = document.querySelectorAll('.stream-card');
    cards.forEach(c => c.classList.remove('selected'));
    SELECTED_INDEX = -1;
    modal.remove();
  }
  document.body.appendChild(modal);
  // Try to present as full viewport (visually full-screen)
  try { document.documentElement.style.overflow = 'hidden'; } catch(e){}
  document.getElementById('streaming-close').addEventListener('click', () => { try { document.documentElement.style.overflow = ''; } catch(e){}; closeModal(); });
  // Fullscreen button: toggle fullscreen for the wrap
  const wrap = modal.querySelector('.streaming-player-wrap');
  document.getElementById('streaming-full').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await wrap.requestFullscreen();
      else await document.exitFullscreen();
    } catch(e) {}
  });
  // If a preloaded video exists, try to play it immediately (user clicked)
  try {
    const p = document.getElementById('pincerna-player');
    if (p) {
      // if video element not yet loaded source, set src
      const source = p.querySelector('source');
      if (source && source.src) {
        try { p.currentTime = 0; p.play().catch(()=>{}); } catch(e){}
      }
      // clicking the body toggles fullscreen on the video wrapper
      p.addEventListener('click', async (ev) => { ev.stopPropagation(); try { if (!document.fullscreenElement) await wrap.requestFullscreen(); } catch(e){} });
    }
  } catch(e){}
  // Close modal with Escape
  const escHandler = (e) => { if (e.key === 'Escape') { try { document.documentElement.style.overflow = ''; } catch(e){}; closeModal(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
}

function drawGridLines(gatewayIp) {
  const svg = document.getElementById('grid-svg');
  const grid = document.getElementById('network-devices');
  if (!svg || !grid) return;
  
  const rect = grid.getBoundingClientRect();
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  
  const gatewayEl = document.getElementById(`grid-device-${gatewayIp?.replace(/\./g, '-')}`);
  if (!gatewayEl) {
    svg.innerHTML = '';
    return;
  }
  
  const gatewayRect = gatewayEl.getBoundingClientRect();
  const gx = gatewayRect.left + gatewayRect.width / 2 - rect.left;
  const gy = gatewayRect.top + gatewayRect.height / 2 - rect.top;
  
  let lines = '';
  
  grid.querySelectorAll('.network-device').forEach(el => {
    if (el.dataset.ip === gatewayIp) return;
    
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 - rect.left;
    const y = r.top + r.height / 2 - rect.top;
    const isOnline = el.classList.contains('online') || el.classList.contains('server');
    
    lines += `<line x1="${gx}" y1="${gy}" x2="${x}" y2="${y}" class="grid-line ${isOnline ? '' : 'offline'}"/>`;
  });
  
  svg.innerHTML = lines;
}

function renderQuickActions(device) {
  const actions = [];
  const services = device.services || [];
  const displayName = getDeviceDisplayName(device);
  
  if (services.some(s => s.port === 3389)) {
    actions.push(`<button class="quick-action rdp" onclick="event.stopPropagation(); showConnectionInfo('rdp', '${device.ip}', '${displayName}')" title="Remote Desktop"><span>🖥︎</span> RDP</button>`);
  }
  
  if (services.some(s => s.port === 5900)) {
    actions.push(`<button class="quick-action vnc" onclick="event.stopPropagation(); showConnectionInfo('vnc', '${device.ip}', '${displayName}')" title="VNC"><span>🖥︎</span> VNC</button>`);
  }
  
  return actions.length > 0 ? actions.join('') : '';
}

function showConnectionInfo(type, ip, name) {
  let title, command, instructions;
  
  switch (type) {
    case 'ssh':
      title = `SSH to ${name}`;
      command = `ssh ${ip}`;
      instructions = `
        <p>Connect via terminal:</p>
        <div class="connection-command">${command}</div>
        <p class="connection-hint">Or use: ssh user@${ip}</p>
        <div class="connection-buttons">
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋︎ Copy Command</button>
          <a href="ssh://${ip}" class="btn">🚀︎ Open SSH App</a>
        </div>
      `;
      break;
    case 'rdp':
      title = `Remote Desktop to ${name}`;
      command = `mstsc /v:${ip}`;
      instructions = `
        <p>Connect via Windows Remote Desktop:</p>
        <div class="connection-command">${command}</div>
        <p class="connection-hint">Or open Remote Desktop Connection and enter: ${ip}</p>
        <div class="connection-buttons">
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋︎ Copy Command</button>
          <a href="rdp://${ip}" class="btn">🚀︎ Open RDP</a>
        </div>
      `;
      break;
    case 'smb':
      title = `File Share on ${name}`;
      command = `\\\\${ip}`;
      instructions = `
        <p>Access shared folders:</p>
        <div class="connection-command">${command}</div>
        <p class="connection-hint">
          <strong>Windows:</strong> Win+R, type \\\\${ip}<br>
          <strong>Mac:</strong> Finder → Go → Connect to Server → smb://${ip}<br>
          <strong>Linux:</strong> Files → Other Locations → smb://${ip}
        </p>
        <div class="connection-buttons">
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋︎ Copy Path</button>
          <a href="smb://${ip}" class="btn">🚀︎ Open in Explorer</a>
        </div>
      `;
      break;
    case 'vnc':
      title = `VNC to ${name}`;
      command = `vnc://${ip}`;
      instructions = `
        <p>Connect via VNC viewer:</p>
        <div class="connection-command">${ip}:5900</div>
        <p class="connection-hint">Use any VNC client (RealVNC, TightVNC, etc.)</p>
        <div class="connection-buttons">
          <button class="btn primary" onclick="copyToClipboard('${ip}:5900')">📋︎ Copy Address</button>
          <a href="vnc://${ip}" class="btn">🚀︎ Open VNC App</a>
        </div>
      `;
      break;
  }
  
  showConnectionModal(title, instructions);
}

function showConnectionModal(title, content) {
  const existing = document.getElementById('connection-modal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'connection-modal';
  modal.className = 'connection-modal';
  modal.innerHTML = `
    <div class="connection-modal-content">
      <div class="connection-modal-header">
        <h3>${title}</h3>
        <button class="connection-modal-close" onclick="closeConnectionModal()">✕</button>
      </div>
      <div class="connection-modal-body">
        ${content}
      </div>
    </div>
  `;
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeConnectionModal();
  });
  
  document.body.appendChild(modal);
}

function closeConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) modal.remove();
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showMessage('Copied to clipboard!', 'info', 1500);
  }).catch(() => {
    showMessage('Failed to copy', 'error');
  });
}

function getDeviceIcon(device) {
  if (device.is_server) return '🖥︎';
  if (device.is_gateway || device.ip === networkGateway) return '📡︎';
  
  const hostname = (device.hostname || '').toLowerCase();
  const ip = device.ip || '';
  
  if (hostname.includes('router') || hostname.includes('gateway') || 
      hostname.includes('netgear') || hostname.includes('linksys') ||
      hostname.includes('asus-rt') || hostname.includes('tp-link') ||
      hostname.includes('dlink') || hostname.includes('ubnt') ||
      hostname.includes('unifi') || hostname.includes('mikrotik') ||
      hostname.includes('openwrt') || hostname.includes('pfsense') ||
      hostname.includes('edgerouter') || hostname.includes('orbi') ||
      hostname.includes('eero') || hostname.includes('mesh') ||
      ip.endsWith('.1') && !device.is_server) return '📡︎';
  
    if (hostname.includes('iphone') || hostname.includes('ipad') || 
      hostname.includes('android') || hostname.includes('phone') ||
      hostname.includes('pixel') || hostname.includes('galaxy') ||
      hostname.includes('oneplus') || hostname.includes('xiaomi')) return '📱︎';
  
  if (hostname.includes('tablet') || hostname.includes('surface')) return '📱︎';
  
    if (hostname.includes('macbook') || hostname.includes('imac') ||
      hostname.includes('mac-') || hostname.includes('apple-')) return '💻︎';
  
    if (hostname.includes('desktop') || hostname.includes('pc-') ||
      hostname.includes('workstation') || hostname.includes('windows')) return '🖥︎';
  
    if (hostname.includes('laptop') || hostname.includes('thinkpad') ||
      hostname.includes('dell-') || hostname.includes('hp-')) return '💻︎';
  
    if (hostname.includes('nas') || hostname.includes('synology') || 
      hostname.includes('qnap') || hostname.includes('drobo') ||
      hostname.includes('freenas') || hostname.includes('truenas') ||
      hostname.includes('unraid')) return '💾︎';
  
    if (hostname.includes('printer') || hostname.includes('epson') ||
      hostname.includes('hp-') || hostname.includes('canon') ||
      hostname.includes('brother')) return '🖨︎';
  
    if (hostname.includes('tv') || hostname.includes('roku') || 
      hostname.includes('firestick') || hostname.includes('chromecast') ||
      hostname.includes('apple-tv') || hostname.includes('shield') ||
      hostname.includes('samsung') || hostname.includes('lg-') ||
      hostname.includes('sony') || hostname.includes('plex')) return '📺︎';
  
    if (hostname.includes('camera') || hostname.includes('cam-') ||
      hostname.includes('ipcam') || hostname.includes('ring') ||
      hostname.includes('nest') || hostname.includes('arlo') ||
      hostname.includes('wyze')) return '📷︎';

    if (hostname.includes('echo') || hostname.includes('alexa') ||
      hostname.includes('google-home') || hostname.includes('homepod') ||
      hostname.includes('hue') || hostname.includes('sonos')) return '🔊︎';
  
    if (hostname.includes('xbox') || hostname.includes('playstation') ||
      hostname.includes('ps4') || hostname.includes('ps5') ||
      hostname.includes('switch') || hostname.includes('nintendo')) return '🎮︎';
  
    if (hostname.includes('raspberry') || hostname.includes('raspberrypi') ||
      hostname.includes('rpi') || hostname.includes('pi-') ||
      hostname.includes('arduino') || hostname.includes('esp')) return '🔌︎';
  
  if (device.online) return '💻︎';
  return '❓︎';
}

function renderDeviceServices(device) {
  if (!device.services || device.services.length === 0) {
    return '<span style="font-size:0.75rem;color:var(--muted)">Click to scan ports</span>';
  }
  
  return device.services.map(svc => {
    const isWeb = ['http', 'https', 'HTTP', 'HTTPS', 'HTTP Alt', 'HTTPS Alt', 'Synology', 'Synology SSL', 'Plex', 'Portainer'].includes(svc.name);
    const protocol = svc.port === 443 || svc.port === 8443 || svc.port === 5001 ? 'https' : 'http';
    
    if (isWeb) {
      return `<a href="${protocol}://${device.ip}:${svc.port}" target="_blank" class="device-service" onclick="event.stopPropagation()">${svc.name} :${svc.port}</a>`;
    }
    return `<span class="device-service">${svc.name} :${svc.port}</span>`;
  }).join('');
}

async function scanDevicePorts(ip) {
  const servicesEl = document.getElementById(`services-${ip.replace(/\./g, '-')}`);
  const actionsEl = document.getElementById(`actions-${ip.replace(/\./g, '-')}`);
  if (!servicesEl) return;
  
  servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">Scanning ports</span>';
  
  try {
    const res = await apiFetch(`/network/device/${ip}/ports`);
    if (res && res.ports) {
      const device = networkDevices.find(d => d.ip === ip);
      if (device) {
        device.services = res.ports;
        servicesEl.innerHTML = renderDeviceServices(device);
        if (actionsEl) actionsEl.innerHTML = renderQuickActions(device);
        saveNetworkState();
      }
      
      if (res.ports.length === 0) {
        servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">No open ports found</span>';
      }
    }
  } catch (e) {
    servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">Scan failed</span>';
  }
}


function updateVPNUI(connected, details = {}) {
  const btn = document.getElementById('btn-vpn');
  const indicator = document.getElementById('vpn-indicator');
  const statusText = document.getElementById('vpn-status-text');
  const vpnPanel = document.getElementById('vpn-panel');
  const vpnDetails = document.getElementById('vpn-details');
  
  const notConfigured = !connected && details.config_exists === false;
  
  if (btn) {
    if (connected) {
      btn.textContent = 'VPN Connected ✓';
      btn.classList.add('active');
      btn.style.background = '#22c55e';
      btn.disabled = false;
    } else if (notConfigured) {
      btn.textContent = 'VPN Not Configured';
      btn.classList.remove('active');
      btn.style.background = '#6b7280';
      btn.disabled = true;
    } else if (details.error) {
      btn.textContent = 'VPN Error';
      btn.classList.remove('active');
      btn.style.background = '#ef4444';
      btn.disabled = false;
    } else {
      btn.textContent = 'Start VPN';
      btn.classList.remove('active');
      btn.style.background = '';
      btn.disabled = false;
    }
  }
  
  if (indicator) {
    if (connected) {
      indicator.className = 'vpn-status-indicator connected';
    } else if (notConfigured) {
      indicator.className = 'vpn-status-indicator not-configured';
    } else if (details.error) {
      indicator.className = 'vpn-status-indicator error';
    } else {
      indicator.className = 'vpn-status-indicator disconnected';
    }
  }
  if (statusText) {
    if (connected) {
      statusText.textContent = 'Connected';
    } else if (notConfigured) {
      statusText.textContent = 'Not Configured';
    } else if (details.error) {
      statusText.textContent = 'Error';
    } else {
      statusText.textContent = 'Disconnected';
    }
  }
  
  if (vpnDetails) {
    vpnDetails.style.display = (connected && !notConfigured) ? 'grid' : 'none';
  }
  
  if (vpnPanel) {
    const isHomeSection = document.getElementById('hero')?.style.display !== 'none';
    vpnPanel.style.display = isHomeSection ? 'block' : 'none';
    if (connected && !notConfigured) getVPNStats();
  }
}

async function toggleVPN() {
  const btn = document.getElementById('btn-vpn');
  if (btn) {
    btn.textContent = vpnConnected ? 'Disconnecting' : 'Connecting';
    btn.disabled = true;
  }
  
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
    showMessage('VPN toggle failed: ' + e.message, 'error');
    checkVPNStatus();
  }
  
  if (btn) btn.disabled = false;
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
  if (isDir) return '🗎︎';
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
  };
  return icons[ext] || '🗎︎';
}

function renderFileList(items, path) {
  const out = document.getElementById('file-list');
  if (!out) return;
  out.innerHTML = '';

    if (path && path !== '/') {
    const upDiv = document.createElement('div');
    upDiv.className = 'file-entry file-dir';
    upDiv.innerHTML = `
      <div class="file-info">
        <span class="file-icon">🗎︎</span>
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
    if (path === '/') out.innerHTML += '<div class="file-entry"><div class="file-info"><span class="file-icon">🗐︎</span><div class="file-details"><div class="file-name">Empty folder</div></div></div></div>';
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
        downloadFile(item);
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
  if (statusText) statusText.textContent = `Uploading ${file.name}`;
  if (progressFill) progressFill.style.width = '0%';
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('path', currentPath);
  
  try {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const videoExts = ['mp4','mkv','mov','webm','avi'];
    const largeThreshold = 8 * 1024 * 1024;
    if (videoExts.includes(ext) && file.size > largeThreshold) {
      await chunkedUpload(file, progressFill, statusText);
      refreshFiles();
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && progressFill) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = percent + '%';
        if (statusText) statusText.textContent = `Uploading ${file.name} ${percent}%`;
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        if (statusText) statusText.textContent = `Uploaded ${file.name} ✓`;
        setTimeout(() => { if (progressDiv) progressDiv.style.display = 'none'; }, 2000);
        refreshFiles();
      } else {
        if (statusText) statusText.textContent = `Upload failed`;
        showMessage('Upload failed', 'error');
      }
    });
    xhr.addEventListener('error', () => { if (statusText) statusText.textContent = `Upload error`; showMessage('Upload failed', 'error'); });
    const token = localStorage.getItem('pincerna_token');
    xhr.open('POST', apiBase + '/files/upload');
    if (token) xhr.setRequestHeader('Authorization', token);
    xhr.send(formData);
  } catch (e) {
    showMessage('Upload failed: ' + e.message, 'error');
    if (progressDiv) progressDiv.style.display = 'none';
  }
}

async function chunkedUpload(file, progressFill, statusText) {
  const chunkSize = 4 * 1024 * 1024;
  const total = file.size;
  const totalChunks = Math.ceil(total / chunkSize);
  const uploadId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  let uploadedBytes = 0;
  const concurrency = 4;

  const sendChunk = async (index) => {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, total);
    const blob = file.slice(start, end);
    const fd = new FormData();
    fd.append('upload_id', uploadId);
    fd.append('index', index);
    fd.append('total', totalChunks);
    fd.append('filename', file.name);
    fd.append('path', currentPath);
    fd.append('chunk', blob);
    const token = localStorage.getItem('pincerna_token');
    const res = await fetch(apiBase + '/files/upload_chunk', { method: 'POST', body: fd, headers: token ? { 'Authorization': token } : {} });
    if (!res.ok) throw new Error('chunk upload failed');
    uploadedBytes += (end - start);
    const percent = Math.round((uploadedBytes / total) * 100);
    if (progressFill) progressFill.style.width = percent + '%';
    if (statusText) statusText.textContent = `Uploading ${file.name} ${percent}%`;
  };

  const queue = Array.from({length: totalChunks}, (_, i) => i);
  const runners = Array.from({length: Math.min(concurrency, queue.length)}, async () => {
    while (queue.length) {
      const idx = queue.shift();
      await sendChunk(idx);
    }
  });
  await Promise.all(runners);
  if (statusText) statusText.textContent = `Finalizing ${file.name}`;
  const completeResp = await apiFetch('/files/upload_complete', { method: 'POST', body: JSON.stringify({ upload_id: uploadId, filename: file.name, path: currentPath }), headers: { 'Content-Type': 'application/json' } });
  if (completeResp && completeResp.success) {
    if (statusText) statusText.textContent = `Uploaded ${file.name} ✓`;
    setTimeout(() => { const progressDiv = document.getElementById('upload-progress'); if (progressDiv) progressDiv.style.display = 'none'; }, 1500);
  } else {
    throw new Error(completeResp && completeResp.error ? completeResp.error : 'upload_complete_failed');
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
  if (indicator) indicator.textContent = 'Connecting';

    if (!localStorage.getItem('pincerna_token')) {
    window.location.href = 'auth.html';
    return;
  }

  const btnLogout = $('#btn-logout');
  if (btnLogout) btnLogout.addEventListener('click', logout);
  
  const btnVpn = document.getElementById('btn-vpn');
  if (btnVpn) btnVpn.addEventListener('click', toggleVPN);
  
  const btnAccessLocal = $('#btn-access-local');
  if (btnAccessLocal) btnAccessLocal.addEventListener('click', () => { document.getElementById('nav-files').click(); });

    const btnMetrics = document.getElementById('btn-metrics');
  if (btnMetrics) btnMetrics.addEventListener('click', loadMetrics);

  const btnRefreshMetrics = document.getElementById('btn-refresh-metrics');
  if (btnRefreshMetrics) btnRefreshMetrics.addEventListener('click', loadMetrics);

  const btnVpnRefresh = document.getElementById('btn-vpn-refresh');
  if (btnVpnRefresh) btnVpnRefresh.addEventListener('click', () => {
    checkVPNStatus();
    showMessage('VPN status refreshed', 'info', 1500);
  });

  const btnRestart = document.getElementById('btn-restart');
  if (btnRestart) {
    btnRestart.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to restart the service?')) return;
      const res = await apiFetch('/restart', { method: 'POST' });
      if (res && res.error) showMessage(res.error, 'error');
      else showMessage('Restart command sent', 'info');
    });
  }

    const navHome = $('#nav-home');
    const navFiles = $('#nav-files');
    const navStreaming = $('#nav-streaming');
    const navAbout = $('#nav-about');
    if (navHome) navHome.addEventListener('click', (e) => { e.preventDefault(); showSection('home'); });
    if (navFiles) navFiles.addEventListener('click', (e) => { e.preventDefault(); showSection('files'); refreshFiles(); });
    if (navStreaming) navStreaming.addEventListener('click', (e) => { e.preventDefault(); showSection('streaming'); });
    if (navAbout) navAbout.addEventListener('click', (e) => { e.preventDefault(); showSection('about'); });

    // Video modal close handler
    const closeBtn = document.getElementById('close-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (window.currentVideo) {
          window.currentVideo.pause();
          window.currentVideo.currentTime = 0;
          window.currentVideo.src = '';
          window.currentVideo = null;
        }
        document.getElementById('video-modal').style.display = 'none';
      });
    }

    const btnViewStreaming = document.getElementById('btn-view-network');
    if (btnViewStreaming) btnViewStreaming.addEventListener('click', () => showSection('streaming'));
  
    const btnScanDevices = document.getElementById('btn-scan-devices');
    if (btnScanDevices) btnScanDevices.addEventListener('click', listStorageDevices);

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
        downloadFile(selectedFile);
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

  const token = localStorage.getItem('pincerna_token');
  fetch(apiBase + '/health', {
    headers: token ? { 'Authorization': token } : {}
  }).then(r => {
    if (r.ok) {
      hidePreloader(2000);
    } else {
      if (indicator) indicator.textContent = 'Backend unavailable';
      hidePreloader(2500);
    }
  }).catch(() => {
    if (indicator) indicator.textContent = 'Cannot connect to server';
    hidePreloader(2500);
  });

  startStorageStatusPolling();
});

let _seenBackups = new Set();
// restore seen backups from sessionStorage so reloads don't re-notify
try {
  const sb = sessionStorage.getItem('pincerna_seen_backups');
  if (sb) JSON.parse(sb).forEach(s => _seenBackups.add(s));
} catch (e) {}
async function pollStorageStatus() {
  try {
    const res = await apiFetch('/storage/status');
    if (Array.isArray(res) && res.length > 0) {
      // show any new backups not seen before (deduplicate by dest)
      const now = Date.now();
      const RECENT_MS = 10 * 60 * 1000; // only notify for backups within last 10 minutes
      // only show at most one new toast per poll
      let shown = 0;
      for (const b of res) {
        if (shown >= 1) break;
        if (!b || !b.dest || !b.when) continue;
        const whenTs = Date.parse(b.when);
        if (isNaN(whenTs)) continue;
        if (now - whenTs > RECENT_MS) continue;
        // normalize dest path to avoid minor differences
        const destNorm = b.dest.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!_seenBackups.has(destNorm)) {
          _seenBackups.add(destNorm);
          try { sessionStorage.setItem('pincerna_seen_backups', JSON.stringify(Array.from(_seenBackups))); } catch (e) {}
          showMessage('Backup completed: ' + b.dest, 'info', 5000);
          shown++;
        }
      }
    }
  } catch (e) {}
}

function startStorageStatusPolling() {
  pollStorageStatus();
  setInterval(pollStorageStatus, 8000);
}

function showStreamingPlayerByInfo(info) {
  const path = info.path;
  const name = info.name || (path.split('/').pop());
  const token = localStorage.getItem('pincerna_token') || '';
  const src = apiBase + '/files/preview?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(token);

  const existing = document.getElementById('streaming-player-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'streaming-player-modal';
  modal.className = 'connection-modal';

  const ext = (name.split('.').pop() || '').toLowerCase();
  const videoExts = ['mp4','webm','ogg','mov'];
  const audioExts = ['mp3','wav','m4a','aac','flac'];

  let mediaHtml = '';
  if (videoExts.includes(ext)) mediaHtml = `<video controls autoplay style="width:100%;height:auto;max-height:70vh"><source src="${src}"></video>`;
  else if (audioExts.includes(ext)) mediaHtml = `<audio controls autoplay style="width:100%"><source src="${src}"></audio>`;
  else mediaHtml = `<div style="padding:12px">Cannot play this file in-browser. <a href="${src}" target="_blank">Open</a></div>`;

  const metaHtml = `
    <div style="margin-top:8px;font-size:0.95rem;color:var(--muted)">
      <div><strong>Size:</strong> ${info.size ? formatBytes(info.size) : 'unknown'}</div>
      <div><strong>Modified:</strong> ${info.mtime || ''}</div>
    </div>
  `;

  modal.innerHTML = `
    <div class="connection-modal-content">
      <div class="connection-modal-header">
        <h3>${name}</h3>
        <button class="connection-modal-close" onclick="document.getElementById('streaming-player-modal')?.remove()">✕</button>
      </div>
      <div class="connection-modal-body">${mediaHtml}${metaHtml}</div>
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}