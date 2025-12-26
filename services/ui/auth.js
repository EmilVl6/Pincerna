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

  fetch('/cloud/api/config').then(function(r){ return r.json(); }).then(function(cfg){
    var sitekey = cfg && cfg.turnstile_sitekey;
    if(!sitekey) {
      console.error('No turnstile sitekey found');
      return;
    }
    function renderWhenReady(){
      if(window.turnstile && typeof window.turnstile.render === 'function'){
        window.turnstile.render(document.getElementById('turnstile-container'), {
          sitekey: sitekey,
          callback: window.onTurnstileSuccess
        });
        return;
      }
      setTimeout(renderWhenReady, 100);
    }
    renderWhenReady();
  }).catch(function(e){ console.error('Config fetch failed', e); });
})();
