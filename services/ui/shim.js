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
      try { if (typeof apiFetch === 'function') await apiFetch('/auth/logout', { method: 'POST' }); } catch(e){}
      try { localStorage.removeItem('pincerna_token'); localStorage.removeItem('pincerna_user'); } catch(e){}
      try { window.location.href = 'auth.html'; } catch(e){}
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
        const base = (window.apiBase !== undefined) ? window.apiBase : '/cloud/api';
        const origin = (window.location && window.location.origin) ? window.location.origin : '';
        const pathPart = path && path.startsWith('/') ? path : ('/' + (path || ''));
        const url = origin + base + pathPart;
        const res = await fetch(url, Object.assign({}, opts, { headers }));
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
