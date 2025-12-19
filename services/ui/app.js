const apiBase = "/cloud/api";
const $ = sel => document.querySelector(sel);

function setOutput(v){
  const el = $('#out');
  el.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

async function demoLogin(){
  try{
    let token = 'demo-token';
    try{
      const res = await fetch(apiBase + '/login', {method:'POST'});
      if(res.ok){ const j = await res.json(); token = j.token || token }
    }catch(e){ /**/ }
    localStorage.setItem('pincerna_token', token);
    document.querySelectorAll('.status').forEach(el=>el.textContent = 'Signed in (demo)');
    $('#btn-logout').hidden = false;
    initFiles();
  }catch(err){ setOutput({error: err.message}) }
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
    try{ return JSON.parse(txt) }catch{ return txt }
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
    left.innerHTML = `<strong>${item.name}</strong><div class="meta">${item.size||''} ${item.mtime||''}</div>`;
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
  else setOutput(res);
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
  $('#btn-data').addEventListener('click', async ()=> setOutput(await apiFetch('/data')));
  $('#btn-metrics').addEventListener('click', async ()=> setOutput(await apiFetch('/metrics')));
  $('#btn-restart').addEventListener('click', async ()=> setOutput(await apiFetch('/restart', {method:'POST'})));

  $('#nav-home').addEventListener('click', ()=>{ document.getElementById('controls').style.display='block'; document.getElementById('files').style.display='none'; document.getElementById('nav-home').classList.add('active'); document.getElementById('nav-files').classList.remove('active'); });
  $('#nav-files').addEventListener('click', ()=>{ document.getElementById('controls').style.display='none'; document.getElementById('files').style.display='block'; document.getElementById('nav-home').classList.remove('active'); document.getElementById('nav-files').classList.add('active'); initFiles(); });

  if(localStorage.getItem('pincerna_token')){
    document.querySelectorAll('.status').forEach(el=>el.textContent = 'Token loaded from localStorage');
    $('#btn-logout').hidden = false;
    initFiles();
  }
});
