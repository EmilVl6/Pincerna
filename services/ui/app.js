const apiBase = "/cloud/api";
const $ = sel => document.querySelector(sel);

// Get user info from localStorage
function getUserInfo(){
  try{
    const raw = localStorage.getItem('pincerna_user');
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}

// Display user greeting
function showUserGreeting(){
  const user = getUserInfo();
  const greetEl = document.getElementById('user-greeting');
  const titleEl = document.getElementById('welcome-title');
  if(user && user.given_name){
    if(greetEl) greetEl.textContent = 'Hi, ' + user.given_name;
    if(titleEl) titleEl.textContent = 'Hi ' + user.given_name + '!';
  } else if(user && user.name){
    if(greetEl) greetEl.textContent = 'Hi, ' + user.name.split(' ')[0];
    if(titleEl) titleEl.textContent = 'Hi ' + user.name.split(' ')[0] + '!';
  }
}

// Preloader helper: hide the #preloader element after a small delay
function hidePreloader(delay=700){
  const p = document.getElementById('preloader');
  if(!p) return;
  setTimeout(()=>{
    p.style.transition = 'opacity 220ms ease';
    p.style.opacity = '0';
    setTimeout(()=>{ p.style.display='none'; }, 240);
  }, delay);
}

function showMessage(msg, level='info', timeout=4000){
  const t = document.createElement('div');
  t.className = 'toast ' + (level||'info');
  t.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg);
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity = '0'; setTimeout(()=>t.remove(),300) }, timeout);
  document.querySelectorAll('.status').forEach(el=>el.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg));
}

// Progress rectangles for preloader
function createProgressSteps(names){
  try{
    const list = document.getElementById('preloader-steps'); if(!list) return [];
    list.innerHTML = '';
    list.classList.add('preloader-progress');
    return names.map(n=>{
      const li = document.createElement('li'); li.className = 'step-wrap';
      const rect = document.createElement('div'); rect.className = 'step';
      li.appendChild(rect);
      list.appendChild(li);
      return {li, rect, name: n};
    });
  }catch(e){ return [] }
}

function setIndicator(text, isError){
  try{
    const ind = document.getElementById('preloader-indicator'); if(!ind) return;
    ind.textContent = text || '';
    if(isError) ind.classList.add('error'); else ind.classList.remove('error');
  }catch(e){}
}

function markStepDone(i){
  try{
    if(preloaderFailed) return;
    if(!progressSteps[i]) return;
    progressSteps[i].rect.classList.add('done');
    const next = nextIncomplete();
    if(next === -1) setIndicator('Ready');
    else setIndicator(progressSteps[next].name);
  }catch(e){}
}

function markStepError(i){
  try{
    if(!progressSteps[i]) return;
    preloaderFailed = true;
    progressSteps[i].rect.classList.add('error');
    setIndicator(progressSteps[i].name + ' — failed', true);
  }catch(e){}
}

function _fetchWithTimeout(url, opts={}, timeout=3000){
  return new Promise((resolve, reject)=>{
    const t = setTimeout(()=>reject(new Error('timeout')), timeout);
    fetch(url, opts).then(r=>{ clearTimeout(t); resolve(r); }).catch(e=>{ clearTimeout(t); reject(e); });
  });
}

async function animateProgress(delayMs=220){
  for(let i=0;i<progressSteps.length;i++){
    if(preloaderFailed) break;
    const step = progressSteps[i];
    setIndicator(step.name);
    // handler for specific steps
    try{
      if(i === 3){
        // Connecting to backend: check health endpoint
        try{
          const res = await _fetchWithTimeout(apiBase + '/health', {}, 3000);
          if(!res || !res.ok){ markStepError(i); break; }
          markStepDone(i);
        }catch(e){ markStepError(i); break; }
      } else if(i === 4){
        // Authenticating: ensure token exists
        const token = localStorage.getItem('pincerna_token');
        if(!token){ markStepError(i); break; }
        markStepDone(i);
      } else {
        // simple progress mark after delay
        await new Promise(r=>setTimeout(r, delayMs));
        markStepDone(i);
      }
    }catch(e){ markStepError(i); break; }
  }
  if(!preloaderFailed) hidePreloader(300);
}

function nextIncomplete(){ try{ return progressSteps.findIndex(s=>!s.rect.classList.contains('done') && !s.rect.classList.contains('error')); }catch(e){return -1} }

const PROGRESS_NAMES = ['Initializing interface','Loading assets','Resolving tunnel','Connecting to backend','Authenticating','Loading files','Ready'];
let progressSteps = [];
let preloaderFailed = false;

// Failsafe: if steps are still incomplete after 6s, mark the next step as error (unless already failed)
setTimeout(()=>{
  if(preloaderFailed) return;
  const idx = nextIncomplete();
  if(idx !== -1){ markStepError(idx); }
}, 6000);

async function demoLogin(){
  try{
    let token = 'demo-token';
    try{
      const res = await fetch(apiBase + '/login', {method:'POST'});
      if(res.ok){ const j = await res.json(); token = j.token || token }
    }catch(e){}
    localStorage.setItem('pincerna_token', token);
    document.querySelectorAll('.status').forEach(el=>el.textContent = 'Signed in (demo)');
    $('#btn-logout').hidden = false;
    if(progressSteps && progressSteps.length) markStepDone(4); // auth
    if(progressSteps && progressSteps.length) markStepDone(5); // files
    await initFiles();
  }catch(err){ showMessage(err.message || 'Login failed','error') }
}

function logout(){
  localStorage.removeItem('pincerna_token');
  localStorage.removeItem('pincerna_user');
  window.location.href = 'auth.html';
}

async function apiFetch(path, opts={}){
  const headers = opts.headers || {};
  const token = localStorage.getItem('pincerna_token');
  if(token) headers['Authorization'] = token;
  try{
    const res = await fetch(apiBase + path, {...opts, headers});
    const txt = await res.text();
    if(typeof txt === 'string' && txt.trim().startsWith('<')) return {error:'server_returned_html'};
    try{ return JSON.parse(txt) }catch(e){ return txt }
  }catch(e){ return {error: e.message} }
}

let currentPath = '/';
async function listFiles(path=currentPath){
  const q = '?path=' + encodeURIComponent(path);
  const res = await apiFetch('/files' + q);
  return res;
}

function renderFileList(items){
  const out = document.getElementById('file-list');
  out.innerHTML = '';
  if(!items || !Array.isArray(items) || items.length===0){
    out.textContent = 'No files.'; return;
  }
  items.forEach(item=>{
    const div = document.createElement('div');
    div.className = 'file-entry';
    const left = document.createElement('div');
    const nameEl = document.createElement('strong');
    nameEl.textContent = item.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = (item.size||'') + ' ' + (item.mtime||'');
    left.appendChild(nameEl);
    left.appendChild(metaEl);
    const actions = document.createElement('div'); actions.className='actions';
    const dl = document.createElement('button'); dl.className='btn'; dl.textContent='Download';
    dl.addEventListener('click', ()=>{ window.location = '/cloud/api/files/download?path=' + encodeURIComponent(item.path) });
    const del = document.createElement('button'); del.className='btn'; del.textContent='Delete';
    del.addEventListener('click', async ()=>{ if(confirm('Delete '+item.name+'?')){ await apiFetch('/files?path='+encodeURIComponent(item.path), {method:'DELETE'}); refreshFiles(); } });
    actions.appendChild(dl); actions.appendChild(del);
    div.appendChild(left); div.appendChild(actions);
    out.appendChild(div);
  });
}

async function refreshFiles(){
  const res = await listFiles();
  if(res && res.files) renderFileList(res.files);
  else if(res && res.error === 'server_returned_html') showMessage('Server returned HTML instead of JSON; backend missing or misconfigured','error');
  else showMessage(res.error || res, 'error');
  return res;
}

async function initFiles(){
  try{
    const input = document.getElementById('file-input');
    if(input) input.addEventListener('change', async (ev)=>{
      const f = ev.target.files[0]; if(!f) return;
      const fd = new FormData(); fd.append('file', f); fd.append('path', currentPath);
      await fetch(apiBase + '/files/upload', {method:'POST', body:fd});
      document.getElementById('file-input').value = '';
      await refreshFiles();
    });
    const btn = document.getElementById('btn-refresh-files'); if(btn) btn.addEventListener('click', refreshFiles);
    if(progressSteps && progressSteps.length) markStepDone(3); // connecting
    const res = await refreshFiles();
    if(res && res.files){
      if(progressSteps && progressSteps.length) markStepDone(5); // files
      if(progressSteps && progressSteps.length) markStepDone(6); // ready
    } else {
      if(progressSteps && progressSteps.length) markStepDone(6); // ready
    }
    // hide preloader when initial load completes
    hidePreloader(500);
  }catch(e){ const idx = nextIncomplete(); if(idx !== -1) markStepError(idx); hidePreloader(800); }
}

document.addEventListener('DOMContentLoaded', ()=>{
  // Show user greeting immediately if we have user info
  showUserGreeting();
  
  // Simplified preloader - just show loading then hide after init
  const indicator = document.getElementById('preloader-indicator');
  if(indicator) indicator.textContent = 'Connecting...';
  
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-vpn').addEventListener('click', toggleVPN);
  $('#btn-access-local').addEventListener('click', ()=>{ document.getElementById('nav-files').click(); });
  
  // Control buttons
  const btnData = document.getElementById('btn-data');
  const btnMetrics = document.getElementById('btn-metrics');
  const btnRestart = document.getElementById('btn-restart');
  
  if(btnData) btnData.addEventListener('click', async ()=>{
    const res = await apiFetch('/data');
    if(res && res.message) showMessage(res.message, 'info');
    else if(res && res.error) showMessage(res.error, 'error');
    else showMessage('Data fetched', 'info');
  });
  
  if(btnMetrics) btnMetrics.addEventListener('click', async ()=>{
    const metricsSection = document.getElementById('metrics');
    if(metricsSection) metricsSection.style.display = 'block';
    try{
      const res = await apiFetch('/metrics');
      if(res && (res.cpu !== undefined || res.memory !== undefined)){
        updateMetrics({cpu: res.cpu || 0, mem: res.memory || 0, disk: 0});
        showMessage('Metrics loaded', 'info');
      } else {
        updateMetrics(sampleMetrics());
        showMessage('Using sample metrics', 'info');
      }
    }catch(e){
      updateMetrics(sampleMetrics());
    }
  });
  
  if(btnRestart) btnRestart.addEventListener('click', async ()=>{
    if(!confirm('Are you sure you want to restart the service?')) return;
    const res = await apiFetch('/restart', {method:'POST'});
    if(res && res.error) showMessage(res.error, 'error');
    else showMessage('Restart command sent', 'info');
  });

  // Navigation - clean section switching
  function showSection(sectionId) {
    // Hide all sections
    ['hero', 'controls', 'files', 'metrics', 'about'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.style.display = 'none';
    });
    // Remove active from all nav
    document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
    
    // Show requested section(s)
    if(sectionId === 'home') {
      const hero = document.getElementById('hero');
      const controls = document.getElementById('controls');
      if(hero) hero.style.display = 'block';
      if(controls) controls.style.display = 'block';
      const navHome = document.getElementById('nav-home');
      if(navHome) navHome.classList.add('active');
    } else if(sectionId === 'files') {
      const files = document.getElementById('files');
      if(files) files.style.display = 'block';
      const navFiles = document.getElementById('nav-files');
      if(navFiles) navFiles.classList.add('active');
    } else if(sectionId === 'about') {
      const about = document.getElementById('about');
      if(about) about.style.display = 'block';
      const navAbout = document.getElementById('nav-about');
      if(navAbout) navAbout.classList.add('active');
    }
  }
  
  $('#nav-home').addEventListener('click', (e) => { e.preventDefault(); showSection('home'); });
  $('#nav-files').addEventListener('click', (e) => { e.preventDefault(); showSection('files'); refreshFiles(); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); showSection('about'); });

  if(localStorage.getItem('pincerna_token')){
    // User is authenticated - initialize the app
    if(indicator) indicator.textContent = 'Loading';
    // Show dashboard by default
    showSection('home');
    // Check backend health and hide preloader
    fetch(apiBase + '/health').then(r => {
      if(r.ok) {
        hidePreloader(300);
      } else {
        if(indicator) indicator.textContent = 'Backend unavailable';
        hidePreloader(1500);
      }
    }).catch(() => {
      if(indicator) indicator.textContent = 'Cannot connect to server';
      hidePreloader(1500);
    });
  } else {
    // No token - redirect to auth
    window.location.href = 'auth.html';
  }
  const vpn = localStorage.getItem('pincerna_vpn') === '1';
  updateVPNUI(vpn);
  // mark init step and assets as done early
  if(progressSteps && progressSteps.length) markStepDone(0);
  if(progressSteps && progressSteps.length) markStepDone(1);
});

function updateVPNUI(connected){
  const btn = document.getElementById('btn-vpn');
  if(!btn) return;
  if(connected){ btn.textContent = 'VPN Connected'; btn.classList.add('active'); }
  else { btn.textContent = 'Start VPN'; btn.classList.remove('active'); }
}

async function toggleVPN(){
  const now = localStorage.getItem('pincerna_vpn') === '1';
  const next = !now;
  localStorage.setItem('pincerna_vpn', next ? '1' : '0');
  updateVPNUI(next);
  showMessage(next ? 'VPN enabled (UI only). Configure WireGuard for real VPN.' : 'VPN disabled');
}

function sampleMetrics(){
  const now = Date.now();
  return {cpu: Math.round(20 + Math.random()*60), mem: Math.round(30 + Math.random()*50), disk: Math.round(40 + Math.random()*40), time: now, cpuHistory: Array.from({length:60}, ()=>Math.round(10+Math.random()*80))};
}

function updateMetrics(data){
  const canvas = document.getElementById('metrics-canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const h = canvas.height; ctx.clearRect(0,0,w,h);
  const pad = 24; const innerW = w - pad*2;
  const barW = Math.floor(innerW/3 - 16);
  const bars = [ {label:'CPU', val: data.cpu}, {label:'Mem', val: data.mem}, {label:'Disk', val: data.disk} ];
  bars.forEach((b,i)=>{
    const x = pad + i*(barW+24);
    const y = h - pad - 40;
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x,y - 120, barW, 120);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(x,y - Math.round(120 * (b.val/100)), barW, Math.round(120 * (b.val/100)));
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--coco').trim(); ctx.fillRect(x, y - Math.round(120 * (b.val/100)), barW, 6);
    ctx.fillStyle = '#e6eef8'; ctx.font = '18px sans-serif'; ctx.fillText(b.label, x, y + 22);
    ctx.fillStyle = 'var(--muted)'; ctx.font = '14px sans-serif'; ctx.fillText(b.val + '%', x, y - Math.round(120 * (b.val/100)) - 8);
  });
  const hist = data.cpuHistory && data.cpuHistory.length ? data.cpuHistory : Array.from({length:60}, ()=>Math.round(10+Math.random()*80));
  const gx = pad; const gy = pad; const gw = innerW; const gh = 80; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath();
  hist.forEach((v,i)=>{ const px = gx + i*(gw/hist.length); const py = gy + gh - (v/100)*gh; if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py); }); ctx.stroke();
  ctx.fillStyle = 'var(--muted)'; ctx.font='14px sans-serif'; ctx.fillText('CPU history (last samples)', gx, gy-6);
}
