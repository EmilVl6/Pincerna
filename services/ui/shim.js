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
})();
