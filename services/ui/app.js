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

function hidePreloader(delay = 2000) {
  const p = document.getElementById('preloader');
  if (!p) return;
  // Ensure minimum time for animation to play
  const minAnimationTime = 1800;
  const actualDelay = Math.max(delay, minAnimationTime);
  setTimeout(() => {
    p.style.transition = 'opacity 400ms ease';
    p.style.opacity = '0';
    setTimeout(() => { p.style.display = 'none'; }, 420);
  }, actualDelay);
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
  ['hero', 'controls', 'files', 'metrics', 'about', 'network-panel'].forEach(id => {
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
  } else if (sectionId === 'network') {
    const networkPanel = document.getElementById('network-panel');
    if (networkPanel) networkPanel.style.display = 'block';
    const navNetwork = document.getElementById('nav-network');
    if (navNetwork) navNetwork.classList.add('active');
    // Update toggle button to reflect current view mode
    const btn = document.getElementById('btn-toggle-view');
    if (btn) btn.textContent = viewMode === 'grid' ? 'Map View' : 'Grid View';
    // Restore saved state or auto-scan if no cached data
    if (restoreNetworkState() && networkDevices.length > 0) {
      // Re-render with cached data
      if (viewMode === 'map') {
        renderNetworkMap(networkDevices, networkGateway);
      } else {
        renderNetworkDevices(networkDevices, networkGateway);
      }
    } else {
      scanNetwork();
    }
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
  
  showMessage(`Downloading ${item.name}...`, 'info', 3000);
  
  // Use fetch + blob for reliable downloads
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
    // Create blob URL and trigger download
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
  
  // Create preview URL with token
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

// ==================== NETWORK SCANNING ====================

let networkDevices = [];
let isScanning = false;
let deviceNicknames = {};
let viewMode = 'grid'; // 'grid' or 'map'
let networkGateway = '';  // Store gateway IP for device classification

// Load saved nicknames from localStorage
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

// Persist network state to sessionStorage (survives navigation)
function saveNetworkState() {
  try {
    sessionStorage.setItem('pincerna_network_devices', JSON.stringify(networkDevices));
    sessionStorage.setItem('pincerna_network_gateway', networkGateway);
    sessionStorage.setItem('pincerna_network_viewmode', viewMode);
  } catch (e) {}
}

function restoreNetworkState() {
  try {
    const devices = sessionStorage.getItem('pincerna_network_devices');
    const gateway = sessionStorage.getItem('pincerna_network_gateway');
    const mode = sessionStorage.getItem('pincerna_network_viewmode');
    if (devices) networkDevices = JSON.parse(devices);
    if (gateway) networkGateway = gateway;
    if (mode) viewMode = mode;
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
  if (statusText) statusText.textContent = 'Scanning network...';
  
  try {
    const res = await apiFetch('/network/scan');
    
    if (res && res.devices) {
      networkDevices = res.devices;
      networkGateway = res.gateway || '';
      saveNetworkState();
      
      // Mark gateway device
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
        if (viewMode === 'map') {
          renderNetworkMap(res.devices, networkGateway);
        } else {
          renderNetworkDevices(res.devices, networkGateway);
        }
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
  
  // Sort devices: gateway first, then server, then by IP
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
  
  // Add click handlers
  grid.querySelectorAll('.network-device').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.device-edit-btn') || e.target.closest('.device-quick-actions') || e.target.closest('.device-services')) return;
      const ip = el.dataset.ip;
      scanDevicePorts(ip);
    });
  });
  
  // Add edit nickname handlers
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
  
  // Draw grid connection lines after layout settles
  setTimeout(() => drawGridLines(gatewayIp), 100);
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
  
  // Check for RDP (port 3389)
  if (services.some(s => s.port === 3389)) {
    actions.push(`<button class="quick-action rdp" onclick="event.stopPropagation(); showConnectionInfo('rdp', '${device.ip}', '${displayName}')" title="Remote Desktop"><span>🖥</span> RDP</button>`);
  }
  
  // Check for VNC (port 5900)
  if (services.some(s => s.port === 5900)) {
    actions.push(`<button class="quick-action vnc" onclick="event.stopPropagation(); showConnectionInfo('vnc', '${device.ip}', '${displayName}')" title="VNC"><span>🖥</span> VNC</button>`);
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
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋 Copy Command</button>
          <a href="ssh://${ip}" class="btn">🚀 Open SSH App</a>
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
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋 Copy Command</button>
          <a href="rdp://${ip}" class="btn">🚀 Open RDP</a>
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
          <button class="btn primary" onclick="copyToClipboard('${command}')">📋 Copy Path</button>
          <a href="smb://${ip}" class="btn">🚀 Open in Explorer</a>
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
          <button class="btn primary" onclick="copyToClipboard('${ip}:5900')">📋 Copy Address</button>
          <a href="vnc://${ip}" class="btn">🚀 Open VNC App</a>
        </div>
      `;
      break;
  }
  
  showConnectionModal(title, instructions);
}

function showConnectionModal(title, content) {
  // Remove any existing modal
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
  // Check explicit flags first
  if (device.is_server) return '🖥️';
  if (device.is_gateway || device.ip === networkGateway) return '📡';
  
  const hostname = (device.hostname || '').toLowerCase();
  const ip = device.ip || '';
  
  // Router/Gateway detection (common patterns)
  if (hostname.includes('router') || hostname.includes('gateway') || 
      hostname.includes('netgear') || hostname.includes('linksys') ||
      hostname.includes('asus-rt') || hostname.includes('tp-link') ||
      hostname.includes('dlink') || hostname.includes('ubnt') ||
      hostname.includes('unifi') || hostname.includes('mikrotik') ||
      hostname.includes('openwrt') || hostname.includes('pfsense') ||
      hostname.includes('edgerouter') || hostname.includes('orbi') ||
      hostname.includes('eero') || hostname.includes('mesh') ||
      ip.endsWith('.1') && !device.is_server) return '📡';
  
  // Phones
  if (hostname.includes('iphone') || hostname.includes('ipad') || 
      hostname.includes('android') || hostname.includes('phone') ||
      hostname.includes('pixel') || hostname.includes('galaxy') ||
      hostname.includes('oneplus') || hostname.includes('xiaomi')) return '📱';
  
  // Tablets
  if (hostname.includes('tablet') || hostname.includes('surface')) return '📱';
  
  // Apple devices
  if (hostname.includes('macbook') || hostname.includes('imac') ||
      hostname.includes('mac-') || hostname.includes('apple-')) return '💻';
  
  // Windows PC detection
  if (hostname.includes('desktop') || hostname.includes('pc-') ||
      hostname.includes('workstation') || hostname.includes('windows')) return '🖥️';
  
  // Laptops
  if (hostname.includes('laptop') || hostname.includes('thinkpad') ||
      hostname.includes('dell-') || hostname.includes('hp-')) return '💻';
  
  // NAS devices
  if (hostname.includes('nas') || hostname.includes('synology') || 
      hostname.includes('qnap') || hostname.includes('drobo') ||
      hostname.includes('freenas') || hostname.includes('truenas') ||
      hostname.includes('unraid')) return '💾';
  
  // Printers
  if (hostname.includes('printer') || hostname.includes('epson') ||
      hostname.includes('hp-') || hostname.includes('canon') ||
      hostname.includes('brother')) return '🖨️';
  
  // Smart TV / Media
  if (hostname.includes('tv') || hostname.includes('roku') || 
      hostname.includes('firestick') || hostname.includes('chromecast') ||
      hostname.includes('apple-tv') || hostname.includes('shield') ||
      hostname.includes('samsung') || hostname.includes('lg-') ||
      hostname.includes('sony') || hostname.includes('plex')) return '📺';
  
  // Cameras
  if (hostname.includes('camera') || hostname.includes('cam-') ||
      hostname.includes('ipcam') || hostname.includes('ring') ||
      hostname.includes('nest') || hostname.includes('arlo') ||
      hostname.includes('wyze')) return '📷';
  
  // Smart home devices
  if (hostname.includes('echo') || hostname.includes('alexa') ||
      hostname.includes('google-home') || hostname.includes('homepod') ||
      hostname.includes('hue') || hostname.includes('sonos')) return '🔊';
  
  // Gaming
  if (hostname.includes('xbox') || hostname.includes('playstation') ||
      hostname.includes('ps4') || hostname.includes('ps5') ||
      hostname.includes('switch') || hostname.includes('nintendo')) return '🎮';
  
  // Raspberry Pi / IoT
  if (hostname.includes('raspberry') || hostname.includes('raspberrypi') ||
      hostname.includes('rpi') || hostname.includes('pi-') ||
      hostname.includes('arduino') || hostname.includes('esp')) return '🔌';
  
  // Default
  if (device.online) return '💻';
  return '❓';
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
  
  servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">Scanning ports...</span>';
  
  try {
    const res = await apiFetch(`/network/device/${ip}/ports`);
    if (res && res.ports) {
      // Update the device in our cache
      const device = networkDevices.find(d => d.ip === ip);
      if (device) {
        device.services = res.ports;
        servicesEl.innerHTML = renderDeviceServices(device);
        if (actionsEl) actionsEl.innerHTML = renderQuickActions(device);
        saveNetworkState(); // Persist port scan results
      }
      
      if (res.ports.length === 0) {
        servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">No open ports found</span>';
      }
    }
  } catch (e) {
    servicesEl.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">Scan failed</span>';
  }
}

// ==================== NETWORK MAP ====================

function renderNetworkMap(devices, gatewayIp) {
  const container = document.getElementById('network-devices');
  if (!container) return;
  
  container.className = 'network-map-container';
  
  // Find the gateway/router using multiple detection methods
  const gateway = devices.find(d => d.ip === gatewayIp) || 
                  devices.find(d => d.is_gateway) ||
                  devices.find(d => (d.hostname || '').toLowerCase().includes('router')) ||
                  devices.find(d => d.ip && d.ip.endsWith('.1'));
  const server = devices.find(d => d.is_server);
  const otherDevices = devices.filter(d => d !== gateway && d !== server);
  
  // Categorize devices for better layout
  const networkDeviceTypes = categorizeDevices(otherDevices);
  
  // Calculate dynamic height based on device count
  const deviceRows = Math.ceil(otherDevices.length / 6);
  const mapHeight = Math.max(520, 340 + (deviceRows * 100));
  
  // Create SVG for connections
  const mapHtml = `
    <div class="network-map" style="height:${mapHeight}px">
      <svg class="network-lines" id="network-svg"></svg>
      
      <!-- Tier 1: Internet Cloud -->
      <div class="map-node internet" id="node-internet" style="top:20px;left:50%;transform:translateX(-50%)">
        <div class="map-node-icon">☁️</div>
        <div class="map-node-label">Internet</div>
      </div>
      
      <!-- Tier 2: Router/Gateway -->
      ${gateway ? `
      <div class="map-node router" id="node-gateway" data-ip="${gateway.ip}" style="top:100px;left:50%;transform:translateX(-50%)">
        <div class="map-node-icon">📡</div>
        <div class="map-node-label">${getDeviceDisplayName(gateway)}</div>
        <div class="map-node-ip">${gateway.ip}</div>
        <div class="map-node-badge">Gateway</div>
      </div>
      ` : ''}
      
      <!-- Tier 3: Server (Pincerna) -->
      ${server ? `
      <div class="map-node server" id="node-server" data-ip="${server.ip}" style="top:200px;left:50%;transform:translateX(-50%)">
        <div class="map-node-icon">🖥️</div>
        <div class="map-node-label">${getDeviceDisplayName(server)}</div>
        <div class="map-node-ip">${server.ip}</div>
        <div class="map-node-badge">This Server</div>
      </div>
      ` : ''}
      
      <!-- Tier 4: Client Devices - arranged in rows -->
      <div class="map-devices-area" id="devices-area">
        ${renderMapDevices(otherDevices)}
      </div>
    </div>
    
    <!-- Device Detail Panel -->
    <div class="map-device-detail" id="map-device-detail" style="display:none">
      <div class="detail-header">
        <span class="detail-icon" id="detail-icon"></span>
        <div class="detail-info">
          <div class="detail-name" id="detail-name"></div>
          <div class="detail-ip" id="detail-ip"></div>
        </div>
        <button class="detail-close" id="detail-close">✕</button>
      </div>
      <div class="detail-actions" id="detail-actions"></div>
      <div class="detail-services" id="detail-services"></div>
    </div>
  `;
  
  container.innerHTML = mapHtml;
  
  // Draw connection lines after a brief delay to let layout settle
  setTimeout(() => drawNetworkLines(), 100);
  
  // Add click handlers for nodes
  container.querySelectorAll('.map-node[data-ip]').forEach(node => {
    node.addEventListener('click', () => {
      const ip = node.dataset.ip;
      showMapDeviceDetail(ip);
    });
  });
  
  // Close detail panel
  const closeBtn = document.getElementById('detail-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('map-device-detail').style.display = 'none';
    });
  }
}

function categorizeDevices(devices) {
  // Group devices by type for smarter layout
  const categories = {
    computers: [],
    mobile: [],
    iot: [],
    other: []
  };
  
  devices.forEach(device => {
    const icon = getDeviceIcon(device);
    if (['💻', '🖥️', '🖳', '🖴'].includes(icon)) {
      categories.computers.push(device);
    } else if (['📱', '📲'].includes(icon)) {
      categories.mobile.push(device);
    } else if (['💡', '🔊', '📺', '🎮', '📷', '🖨️'].includes(icon)) {
      categories.iot.push(device);
    } else {
      categories.other.push(device);
    }
  });
  
  return categories;
}

function renderMapDevices(devices) {
  if (!devices.length) return '';
  
  // Calculate positions in a grid layout
  const perRow = Math.min(6, devices.length);
  const nodeWidth = 110;
  const nodeGap = 20;
  const totalWidth = perRow * nodeWidth + (perRow - 1) * nodeGap;
  
  return devices.map((device, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const devicesInRow = Math.min(perRow, devices.length - row * perRow);
    const rowWidth = devicesInRow * nodeWidth + (devicesInRow - 1) * nodeGap;
    const xOffset = col * (nodeWidth + nodeGap) + (nodeWidth / 2);
    const leftPercent = ((xOffset / rowWidth) * 100);
    const yPos = 300 + row * 100;
    
    return `
      <div class="map-node device ${device.online ? 'online' : 'offline'}" 
           id="node-${device.ip.replace(/\./g, '-')}" 
           data-ip="${device.ip}"
           style="position:absolute;top:${yPos}px;left:calc(${(col + 0.5) * (100 / devicesInRow)}% - 55px);width:100px">
        <div class="map-node-icon">${getDeviceIcon(device)}</div>
        <div class="map-node-label">${getDeviceDisplayName(device)}</div>
        <div class="map-node-ip">${device.ip}</div>
      </div>
    `;
  }).join('');
}

function drawNetworkLines() {
  const svg = document.getElementById('network-svg');
  if (!svg) return;
  
  const container = svg.parentElement;
  const rect = container.getBoundingClientRect();
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  
  let lines = '';
  
  const internet = document.getElementById('node-internet');
  const gateway = document.getElementById('node-gateway');
  const server = document.getElementById('node-server');
  
  // Helper to get center of element relative to container
  function getCenter(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2 - rect.left,
      y: r.top + r.height / 2 - rect.top
    };
  }
  
  // Internet to Gateway
  const internetPos = getCenter(internet);
  const gatewayPos = getCenter(gateway);
  const serverPos = getCenter(server);
  
  if (internetPos && gatewayPos) {
    lines += `<line x1="${internetPos.x}" y1="${internetPos.y}" x2="${gatewayPos.x}" y2="${gatewayPos.y}" class="network-line primary"/>`;
  }
  
  // Gateway to Server
  if (gatewayPos && serverPos) {
    lines += `<line x1="${gatewayPos.x}" y1="${gatewayPos.y}" x2="${serverPos.x}" y2="${serverPos.y}" class="network-line primary"/>`;
  }
  
  // Gateway to all devices
  document.querySelectorAll('.map-node.device').forEach(node => {
    const pos = getCenter(node);
    if (gatewayPos && pos) {
      const isOnline = node.classList.contains('online');
      lines += `<line x1="${gatewayPos.x}" y1="${gatewayPos.y}" x2="${pos.x}" y2="${pos.y}" class="network-line ${isOnline ? '' : 'offline'}"/>`;
    }
  });
  
  svg.innerHTML = lines;
}

function showMapDeviceDetail(ip) {
  const device = networkDevices.find(d => d.ip === ip);
  if (!device) return;
  
  const panel = document.getElementById('map-device-detail');
  const iconEl = document.getElementById('detail-icon');
  const nameEl = document.getElementById('detail-name');
  const ipEl = document.getElementById('detail-ip');
  const actionsEl = document.getElementById('detail-actions');
  const servicesEl = document.getElementById('detail-services');
  
  if (iconEl) iconEl.textContent = getDeviceIcon(device);
  if (nameEl) nameEl.textContent = getDeviceDisplayName(device);
  if (ipEl) ipEl.textContent = device.ip;
  if (actionsEl) actionsEl.innerHTML = renderQuickActions(device) || '<span class="no-actions">Scan for services...</span>';
  if (servicesEl) servicesEl.innerHTML = renderDeviceServices(device);
  
  if (panel) panel.style.display = 'block';
  
  // Trigger port scan
  scanDevicePortsForMap(ip);
}

async function scanDevicePortsForMap(ip) {
  try {
    const res = await apiFetch(`/network/device/${ip}/ports`);
    if (res && res.ports) {
      const device = networkDevices.find(d => d.ip === ip);
      if (device) {
        device.services = res.ports;
        saveNetworkState(); // Persist port scan results
        const actionsEl = document.getElementById('detail-actions');
        const servicesEl = document.getElementById('detail-services');
        if (actionsEl) actionsEl.innerHTML = renderQuickActions(device) || '<span class="no-actions">No remote access ports</span>';
        if (servicesEl) servicesEl.innerHTML = renderDeviceServices(device);
      }
    }
  } catch (e) {}
}

function toggleNetworkView() {
  viewMode = viewMode === 'grid' ? 'map' : 'grid';
  saveNetworkState();
  const btn = document.getElementById('btn-toggle-view');
  if (btn) btn.textContent = viewMode === 'grid' ? 'Map View' : 'Grid View';
  
  if (networkDevices.length > 0) {
    if (viewMode === 'map') {
      renderNetworkMap(networkDevices, networkGateway);
    } else {
      renderNetworkDevices(networkDevices, networkGateway);
    }
  }
}

// ==================== VPN UI ====================

function updateVPNUI(connected, details = {}) {
  const btn = document.getElementById('btn-vpn');
  const indicator = document.getElementById('vpn-indicator');
  const statusText = document.getElementById('vpn-status-text');
  const vpnPanel = document.getElementById('vpn-panel');
  const vpnDetails = document.getElementById('vpn-details');
  
  // Only show not-configured if NOT connected AND config doesn't exist
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
  
  // Hide stats when not configured or disconnected
  if (vpnDetails) {
    vpnDetails.style.display = (connected && !notConfigured) ? 'grid' : 'none';
  }
  
  // Always show VPN panel on home section for status visibility
  if (vpnPanel) {
    const isHomeSection = document.getElementById('hero')?.style.display !== 'none';
    vpnPanel.style.display = isHomeSection ? 'block' : 'none';
    if (connected && !notConfigured) getVPNStats();
  }
}

async function toggleVPN() {
  const btn = document.getElementById('btn-vpn');
  if (btn) {
    btn.textContent = vpnConnected ? 'Disconnecting...' : 'Connecting...';
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
  };
  return icons[ext] || '🗎';
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

  const btnLogout = $('#btn-logout');
  if (btnLogout) btnLogout.addEventListener('click', logout);
  
  // VPN button (optional - may not exist)
  const btnVpn = document.getElementById('btn-vpn');
  if (btnVpn) btnVpn.addEventListener('click', toggleVPN);
  
  const btnAccessLocal = $('#btn-access-local');
  if (btnAccessLocal) btnAccessLocal.addEventListener('click', () => { document.getElementById('nav-files').click(); });

    const btnMetrics = document.getElementById('btn-metrics');
  if (btnMetrics) btnMetrics.addEventListener('click', loadMetrics);

  const btnRefreshMetrics = document.getElementById('btn-refresh-metrics');
  if (btnRefreshMetrics) btnRefreshMetrics.addEventListener('click', loadMetrics);

  // VPN refresh button
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
  const navNetwork = $('#nav-network');
  const navAbout = $('#nav-about');
  if (navHome) navHome.addEventListener('click', (e) => { e.preventDefault(); showSection('home'); });
  if (navFiles) navFiles.addEventListener('click', (e) => { e.preventDefault(); showSection('files'); refreshFiles(); });
  if (navNetwork) navNetwork.addEventListener('click', (e) => { e.preventDefault(); showSection('network'); });
  if (navAbout) navAbout.addEventListener('click', (e) => { e.preventDefault(); showSection('about'); });

  // Network panel buttons
  const btnViewNetwork = document.getElementById('btn-view-network');
  if (btnViewNetwork) btnViewNetwork.addEventListener('click', () => showSection('network'));
  
  const btnScanNetwork = document.getElementById('btn-scan-network');
  if (btnScanNetwork) btnScanNetwork.addEventListener('click', scanNetwork);
  
  const btnToggleView = document.getElementById('btn-toggle-view');
  if (btnToggleView) btnToggleView.addEventListener('click', toggleNetworkView);

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

  // Health check with fallback - always hide preloader
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
});
