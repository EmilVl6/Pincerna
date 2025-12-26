// auth.js - externalized from auth.html to satisfy CSP (no inline scripts)
(function(){
  try{ if(localStorage.getItem('pincerna_token')){ window.location.replace('index.html'); } }catch(e){}
})();

(function(){
  const btn = document.getElementById('signin-btn');
  if(!btn) return;

  const _origHref = btn.getAttribute('href') || '/cloud/api/oauth/start';
  btn.removeAttribute('href');
  btn.setAttribute('aria-disabled','true');
  btn.setAttribute('tabindex','-1');

  let verified = false;

  function enableSignIn(){
    if(verified) return;
    verified = true;
    btn.classList.remove('disabled');
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('tabindex');
    btn.setAttribute('href', _origHref);
    btn.style.cursor = 'pointer';
    document.body.classList.add('turnstile-verified');
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
      if(window.turnstile && typeof window.turnstile.render === 'function'){
        window.turnstile.render(document.getElementById('turnstile-container'), {
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
