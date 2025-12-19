const apiBase = "/cloud/api";
const $ = sel => document.querySelector(sel);

function showMessage(msg, level='info', timeout=4000){
  const t = document.createElement('div');
  t.className = 'toast ' + (level||'info');
  t.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg);
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity = '0'; setTimeout(()=>t.remove(),300) }, timeout);
  document.querySelectorAll('.status').forEach(el=>el.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg));
}

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
    initFiles();
  }catch(err){ showMessage(err.message || 'Login failed','error') }
}

function logout(){
  localStorage.removeItem('pincerna_token');
  document.querySelectorAll('.status').forEach(el=>el.textContent = 'Signed out');
  $('#btn-logout').hidden = true;
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
}

function initFiles(){
  document.getElementById('file-input').addEventListener('change', async (ev)=>{
    const f = ev.target.files[0]; if(!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('path', currentPath);
    await fetch(apiBase + '/files/upload', {method:'POST', body:fd});
    document.getElementById('file-input').value = '';
    refreshFiles();
  });
  document.getElementById('btn-refresh-files').addEventListener('click', refreshFiles);
  refreshFiles();
}

document.addEventListener('DOMContentLoaded', ()=>{
  $('#btn-login').addEventListener('click', demoLogin);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-vpn').addEventListener('click', toggleVPN);
  $('#btn-access-local').addEventListener('click', ()=>{ document.getElementById('nav-files').click(); });
  $('#btn-data').addEventListener('click', async ()=>{ const r = await apiFetch('/data'); showMessage(r.error ? r.error : 'Protected data retrieved', r.error ? 'error' : 'success'); });
  $('#btn-metrics').addEventListener('click', async ()=>{ document.getElementById('controls').style.display='none'; document.getElementById('files').style.display='none'; document.getElementById('about').style.display='none'; document.getElementById('metrics').style.display='block'; document.getElementById('nav-home').classList.remove('active'); document.getElementById('nav-files').classList.remove('active'); document.getElementById('nav-controls').classList.remove('active'); document.getElementById('nav-about').classList.remove('active'); const r = await apiFetch('/metrics'); updateMetrics(r && !r.error ? r : sampleMetrics()); });
  $('#btn-restart').addEventListener('click', async ()=>{ if(!confirm('Restart the service on the Pi?')) return; const r = await apiFetch('/restart', {method:'POST'}); showMessage(r.error ? r.error : 'Restart command sent', r.error ? 'error' : 'success'); });

  $('#nav-home').addEventListener('click', ()=>{ document.getElementById('controls').style.display='block'; document.getElementById('files').style.display='none'; document.getElementById('nav-home').classList.add('active'); document.getElementById('nav-files').classList.remove('active'); });
  $('#nav-files').addEventListener('click', ()=>{ document.getElementById('controls').style.display='none'; document.getElementById('files').style.display='block'; document.getElementById('nav-home').classList.remove('active'); document.getElementById('nav-files').classList.add('active'); initFiles(); });
  $('#nav-controls').addEventListener('click', ()=>{ document.getElementById('controls').style.display='block'; document.getElementById('files').style.display='none'; document.getElementById('about').style.display='none'; document.getElementById('nav-home').classList.remove('active'); document.getElementById('nav-files').classList.remove('active'); document.getElementById('nav-controls').classList.add('active'); document.getElementById('nav-about').classList.remove('active'); });
  $('#nav-about').addEventListener('click', ()=>{ document.getElementById('controls').style.display='none'; document.getElementById('files').style.display='none'; document.getElementById('about').style.display='block'; document.getElementById('nav-home').classList.remove('active'); document.getElementById('nav-files').classList.remove('active'); document.getElementById('nav-controls').classList.remove('active'); document.getElementById('nav-about').classList.add('active'); });

  if(localStorage.getItem('pincerna_token')){
    document.querySelectorAll('.status').forEach(el=>el.textContent = 'Token loaded from localStorage');
    $('#btn-logout').hidden = false;
    initFiles();
  }
  const vpn = localStorage.getItem('pincerna_vpn') === '1';
  updateVPNUI(vpn);
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
