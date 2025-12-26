(function(){
  try {
    // If the OAuth callback redirected here with token in the hash, capture it
    try {
      if (location.hash && location.hash.indexOf('token=') !== -1) {
        const hash = location.hash.substring(1);
        const parts = hash.split('&');
        const params = {};
        parts.forEach(p => { const [k,v] = p.split('='); if (k) params[k] = decodeURIComponent(v||''); });
        if (params.token) {
          try { localStorage.setItem('pincerna_token', params.token); } catch(e){}
        }
        if (params.user) {
          try { localStorage.setItem('pincerna_user', params.user); } catch(e){}
        }
        // Remove the fragment without reloading
        try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
      }

      // quick client-side redirect to auth if no token is present
      // if (!localStorage.getItem('pincerna_token')) {
      //   window.location.href = 'auth.html';
      // }
    } catch (e) {
      // ignore
    }
  } catch (e) {
    // ignore
  }
})();
