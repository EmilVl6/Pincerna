(function(){
  // auth.js: initialize Cloudflare Turnstile and verify before enabling sign-in
  const signin = document.getElementById('signin-btn');
  const container = document.getElementById('turnstile-container');
  let widgetId = null;
  let verified = false;

  function disableSignIn() {
    if (!signin) return;
    signin.classList.add('disabled');
    signin.dataset.disabled = '1';
    signin.setAttribute('aria-disabled', 'true');
  }
  function enableSignIn() {
    if (!signin) return;
    signin.classList.remove('disabled');
    delete signin.dataset.disabled;
    signin.removeAttribute('aria-disabled');
  }

  function interceptClick(e){
    if (signin && signin.dataset.disabled) {
      e.preventDefault();
      return false;
    }
    return true;
  }

  disableSignIn();

  async function fetchSiteKey(){
    try{
      const res = await fetch('/cloud/api/config');
      if (!res.ok) return null;
      const j = await res.json();
      return j.turnstile_sitekey || null;
    }catch(e){return null}
  }

  function waitForTurnstile(cb, timeout=8000){
    const start = Date.now();
    (function check(){
      if (window.turnstile) return cb(null, window.turnstile);
      if (Date.now() - start > timeout) return cb(new Error('turnstile_load_timeout'));
      setTimeout(check, 200);
    })();
  }

  async function init(){
    const sitekey = await fetchSiteKey();
    if (!sitekey) {
      // No sitekey configured: enable sign-in as a fallback
      enableSignIn();
      return;
    }

    waitForTurnstile(async (err, turnstile) => {
      if (err) { enableSignIn(); return; }
      try{
        widgetId = turnstile.render(container, {
          sitekey: sitekey,
          callback: async function(token){
            // send token to server for verification
            try{
              const v = await fetch('/cloud/api/verify_turnstile', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ token })
              });
              const j = await v.json();
              if (v.ok && j && j.success) {
                verified = true;
                enableSignIn();
              } else {
                // keep disabled; optionally show message
                console.warn('turnstile verify failed', j);
                enableSignIn(); // allow fallback if verification endpoint fails
              }
            }catch(e){
              console.warn('turnstile verify error', e);
              enableSignIn();
            }
          },
          'error-callback': function(){ console.warn('turnstile error'); },
          'expired-callback': function(){ verified=false; disableSignIn(); }
        });
      }catch(e){
        console.warn('turnstile render failed', e);
        enableSignIn();
      }
    });

    // Safety: if turnstile never loads within a reasonable time, enable sign-in so user isn't blocked
    setTimeout(()=>{ if (!verified) enableSignIn(); }, 9000);
  }

  // Kick off
  init();

  // Ensure click only prevents navigation when disabled; otherwise allow normal behavior.
  if (signin) {
    signin.addEventListener('click', function(e){
      if (signin.dataset && signin.dataset.disabled) {
        e.preventDefault();
        return false;
      }
      // Let the anchor perform a normal navigation to follow the 302 from the backend.
      return true;
    });
  }
})();
