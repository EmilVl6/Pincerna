// auth.js - externalized from auth.html to satisfy CSP (no inline scripts)
(function(){
  try{ if(localStorage.getItem('pincerna_token')){ window.location.replace('index.html'); } }catch(e){}
})();

(function(){
  const btn = document.getElementById('signin-btn');
  if(!btn) return;

  // read data-href (button) fallback to default
  const _origHref = btn.getAttribute('data-href') || '/cloud/api/oauth/start';
  // keep the button enabled so clicks work even if Turnstile is slow; use classes/aria to indicate state
  try { btn.disabled = false; btn.removeAttribute('aria-disabled'); btn.style.cursor = 'pointer'; } catch(e){}
  // robust click handler: log and navigate via assign with fallback
  try {
    btn.addEventListener('click', function(ev){
      try { console.log('Sign-in clicked, navigating to', _origHref); } catch(e){}
      // prefer location.assign (preserves history) and also ensure navigation via replace if needed
      try { window.location.assign(_origHref); } catch(e) { try { window.location.href = _origHref; } catch(e){} }
      // final fallback: open in same tab after tiny delay
      setTimeout(function(){ try { window.location.replace(_origHref); } catch(e){} }, 250);
    });
  } catch(e){}

  let verified = false;

  function enableSignIn(){
    if(verified) return;
    verified = true;
    try { btn.classList.remove('disabled'); btn.disabled = false; btn.removeAttribute('aria-disabled'); btn.style.cursor = 'pointer'; } catch(e){}
    document.body.classList.add('turnstile-verified');
    // ensure clicking navigates to oauth start
    try { btn.onclick = function(){ window.location.href = _origHref; }; } catch(e){}
  }

  window.onTurnstileSuccess = function(token){
    try { console.log('Turnstile verified!'); } catch(e){}
    enableSignIn();
    fetch('/cloud/api/verify_turnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).catch(function(){});
  };

  // Try to fetch the Turnstile sitekey, but don't block sign-in indefinitely.
  let rendered = false;
  const ENABLE_FALLBACK_MS = 3000;

  function tryRender(sitekey){
    if(!sitekey) return false;
    function renderWhenReady(attemptsLeft){
      const container = document.getElementById('turnstile-container');
      if(window.turnstile && typeof window.turnstile.render === 'function'){
        try { if(container) container.style.display = ''; } catch(e){}
        window.turnstile.render(container, {
          sitekey: sitekey,
          callback: window.onTurnstileSuccess
        });
        rendered = true;
        return;
      }
      if(attemptsLeft <= 0) return;
      setTimeout(()=>renderWhenReady(attemptsLeft-1), 150);
    }
    renderWhenReady(20); // ~3s worth of attempts
    return true;
  }

  // Primary: fetch sitekey from /cloud/api/config, but fallback to enabling sign-in after a short timeout
  fetch('/cloud/api/config', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(cfg){
    var sitekey = cfg && cfg.turnstile_sitekey;
    if(sitekey) {
      tryRender(sitekey);
    } else {
      console.warn('No turnstile sitekey found');
    }
  }).catch(function(e){ console.warn('Config fetch failed', e); });

  // If Turnstile doesn't render within the fallback window, enable sign-in anyway
  setTimeout(function(){ if(!rendered) enableSignIn(); }, ENABLE_FALLBACK_MS);
})();
