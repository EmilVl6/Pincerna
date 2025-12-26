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
  try { btn.disabled = false; btn.setAttribute('aria-disabled','true'); btn.style.cursor = 'pointer'; } catch(e){}
  // ensure clicking always goes to oauth start (Turnstile will verify separately when available)
  try { btn.addEventListener('click', function(ev){ ev.preventDefault(); window.location.href = _origHref; }); } catch(e){}

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
