// Applica subito il tema scelto, prima che la pagina venga disegnata (evita il lampo del tema sbagliato).
(function () {
  try {
    var t = localStorage.getItem('ol_theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage non disponibile */
  }
})();
