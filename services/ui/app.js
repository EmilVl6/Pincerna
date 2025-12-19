const out = id => document.getElementById(id);
const apiBase = "/cloud/api";

function setOutput(v){ out('out').textContent = JSON.stringify(v, null, 2); }

async function login(){
  const res = await fetch(apiBase + '/login', {method:'POST'});
  if(!res.ok){ setOutput({error:'login failed'}); return }
  const {token} = await res.json();
  localStorage.setItem('pincerna_token', token);
  out('login-status').textContent = 'Logged in — token saved';
  document.getElementById('controls').classList.remove('hidden');
}

async function fetchData(){
  const token = localStorage.getItem('pincerna_token');
  const res = await fetch(apiBase + '/data', {headers:{'Authorization': token}});
  const j = await res.json(); setOutput(j);
}

async function fetchMetrics(){
  const res = await fetch(apiBase + '/metrics');
  const j = await res.json(); setOutput(j);
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('btn-login').onclick = login;
  document.getElementById('btn-data').onclick = fetchData;
  document.getElementById('btn-metrics').onclick = fetchMetrics;
  if(localStorage.getItem('pincerna_token')){
    document.getElementById('controls').classList.remove('hidden');
    out('login-status').textContent = 'Token loaded from localStorage';
  }
});
