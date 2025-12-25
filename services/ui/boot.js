(function(){
  try {
    // quick client-side redirect to auth if no token is present
    if (!localStorage.getItem('pincerna_token')) {
      window.location.href = 'auth.html';
    }
  } catch (e) {
    // ignore
  }
})();
