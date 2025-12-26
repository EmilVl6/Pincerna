// Lightweight shims to avoid ReferenceErrors while clients still have cached app.js
(function(){
  if (!window.showUserGreeting) {
    window.showUserGreeting = function() {
      try {
        const raw = localStorage.getItem('pincerna_user');
        const el = document.getElementById && document.getElementById('user-greeting');
        if (!el) return;
        if (raw) {
          try { const info = JSON.parse(raw); const name = info.name || (info.email? info.email.split('@')[0]:null); if (name) el.textContent = `Hi, ${name}`; else el.textContent = ''; } catch(e){ el.textContent = ''; }
        } else {
          el.textContent = '';
        }
      } catch(e){}
    };
  }

  if (!window.logout) {
    window.logout = async function() {
      try { localStorage.removeItem('pincerna_token'); localStorage.removeItem('pincerna_user'); } catch(e){}
      try { localStorage.removeItem('pincerna_last_stream_files'); } catch(e){}
      try { if (window.opener && !window.opener.closed) { try { window.opener.localStorage.removeItem('pincerna_token'); window.opener.localStorage.removeItem('pincerna_user'); } catch(e){} } } catch(e){}
      try { const dest = (window.location && window.location.origin ? window.location.origin : '') + '/cloud/auth.html'; window.location.replace(dest); } catch(e){}
    };
  }
  
  if (!window.hidePreloader) {
    window.hidePreloader = function(delay=0) {
      try {
        const el = document.getElementById('preloader');
        if (!el) return;
        setTimeout(() => { el.style.display = 'none'; }, delay);
      } catch(e){}
    };
  }

  if (!window.showPreloader) {
    window.showPreloader = function() {
      try { const el = document.getElementById('preloader'); if (!el) return; el.style.display = 'block'; } catch(e){}
    };
  }

  if (!window.showMessage) {
    window.showMessage = function(msg, type='info', timeout=3000) {
      try {
        let container = document.getElementById('pincerna-message-container');
        if (!container) {
          container = document.createElement('div');
          container.id = 'pincerna-message-container';
          container.style.position = 'fixed';
          container.style.top = '12px';
          container.style.right = '12px';
          container.style.zIndex = 99999;
          document.body.appendChild(container);
        }
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.marginTop = '8px';
        el.style.padding = '8px 12px';
        el.style.borderRadius = '6px';
        el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
        el.style.background = type === 'error' ? '#ffecec' : (type === 'warn' ? '#fff4e5' : '#eef9ff');
        el.style.color = '#111';
        container.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(()=>el.remove(), 300); }, timeout);
      } catch(e) { console.warn('showMessage fallback failed', e); }
    };
  }

  if (!window.apiFetch) {
    window.apiFetch = async function(path, opts={}) {
      try {
        const headers = (opts.headers && typeof opts.headers === 'object') ? Object.assign({}, opts.headers) : {};
        const token = localStorage.getItem('pincerna_token');
        if (token && !headers['Authorization']) headers['Authorization'] = token;
        // app.js defines `apiBase = "/cloud/api";` — prefer that when available,
        // otherwise default to '/cloud/api'. Build an absolute URL using
        // location.origin so `<base>` in the page cannot cause relative-path
        // resolution issues (which produced requests like "api/cloud/api/...").
        // Always use the canonical base to avoid issues with cached or malformed apiBase
        const base = '/cloud/api';
        const origin = (window.location && window.location.origin) ? window.location.origin.replace(/\/+$/,'') : '';
        // Normalize path: strip any leading '/cloud/api' to avoid duplication
        let pathPart = (path || '').replace(/^\/cloud\/api/, '');
        if (!pathPart.startsWith('/')) pathPart = '/' + pathPart;
        const url = origin + base + pathPart;
        // Attempt several candidate URLs to tolerate cached or rewritten bases.
        const doFetch = async (u) => await fetch(u, Object.assign({}, opts, { headers }));
        const candidates = [];
        // primary
        candidates.push(url);
        try {
          // Ensure pathPart is available here
        } catch(e){}
        // Always try canonical '/cloud/api' prefixed path
        candidates.push(origin + '/cloud/api' + (pathPart || '/'));
        // Try dropping any leading '/api' segment before '/cloud/api'
        if (url.indexOf('/api/cloud/api') !== -1) candidates.push(url.replace('/api/cloud/api', '/cloud/api'));
        // Collapse duplicated '/cloud/api' segments
        if (url.indexOf('/cloud/api/cloud/api') !== -1) candidates.push(url.replace('/cloud/api/cloud/api', '/cloud/api'));
        // If current url doesn't contain '/cloud/api', also try inserting it
        if (url.indexOf('/cloud/api') === -1) {
          const suffix = url.replace(origin, '');
          candidates.push(origin + '/cloud/api' + (suffix.startsWith('/') ? suffix : '/' + suffix));
        }

        let res = null;
        let lastErr = null;
        for (const c of candidates) {
          try {
            res = await doFetch(c);
            if (res && res.status !== 404) {
              // success (or other non-404 error)
              break;
            }
          } catch (e) {
            lastErr = e;
          }
        }
        if (!res) {
          if (lastErr) throw lastErr;
          return { error: 'network_error' };
        }
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok) {
          if (contentType.includes('application/json')) {
            const json = await res.json();
            return json;
          }
          return { error: 'network_error' };
        }
        if (contentType.includes('application/json')) return await res.json();
        return await res.text();
      } catch (e) {
        return { error: e.message };
      }
    };
  }
})();

// On first load, accept tokens delivered via URL fragment (e.g. /cloud/index.html#pincerna_token=...&pincerna_user=...)
// Store into localStorage and remove the fragment to keep the URL clean.
(function(){
  try {
    if (!window || !window.location || !window.location.hash) return;
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = raw.split('&').reduce((acc, part)=>{
      const kv = part.split('=');
      if (kv.length>=2) acc[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('='));
      return acc;
    }, {});
    const t = params['pincerna_token'] || params['token'] || params['t'];
    const u = params['pincerna_user'] || params['user'] || params['u'];
    let changed = false;
    if (t) {
      try { localStorage.setItem('pincerna_token', t); changed = true; } catch(e){}
    }
    if (u) {
      try { localStorage.setItem('pincerna_user', u); changed = true; } catch(e){}
    }
    if (changed) {
      try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname + window.location.search); else window.location.hash = ''; } catch(e){}
      try { if (typeof showUserGreeting === 'function') showUserGreeting(); } catch(e){}
    }
  } catch(e){}
})();
