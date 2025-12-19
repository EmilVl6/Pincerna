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
    $('.status').textContent = 'Signed in (demo)';
    $('#btn-logout').hidden = false;
  }catch(err){ setOutput({error: err.message}) }
}

async function doFetch(path, opts={}){
  const headers = opts.headers || {};
  const token = localStorage.getItem('pincerna_token');
  if(token) headers['Authorization'] = token;
  try{
    const res = await fetch(apiBase + path, {...opts, headers});
    const txt = await res.text();
    try{ const j = JSON.parse(txt); setOutput(j) }catch{ setOutput(txt) }
  }catch(e){ setOutput({error: e.message}) }
}

function logout(){
  localStorage.removeItem('pincerna_token');
  $('.status').textContent = 'Signed out';
  $('#btn-logout').hidden = true;
}

document.addEventListener('DOMContentLoaded', ()=>{
  $('#btn-login').addEventListener('click', demoLogin);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-data').addEventListener('click', ()=>doFetch('/data'));
  $('#btn-metrics').addEventListener('click', ()=>doFetch('/metrics'));
  $('#btn-restart').addEventListener('click', ()=>doFetch('/restart', {method:'POST'}));

  if(localStorage.getItem('pincerna_token')){
    $('.status').textContent = 'Token loaded from localStorage';
    $('#btn-logout').hidden = false;
  }
});
