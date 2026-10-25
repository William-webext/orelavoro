// Tema chiaro/scuro: "auto" segue il dispositivo, altrimenti vale la scelta fatta in "Altro".
// La scelta è salvata solo su questo dispositivo (localStorage).
export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'ol_theme';
const BAR_COLOR = { light: '#0e7490', dark: '#0f1419' } as const;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const root = document.documentElement;
  if (pref === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  // colore della barra di stato / del browser (le due meta con media="prefers-color-scheme")
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  for (const m of metas) {
    if (m.dataset.autoColor === undefined) {
      m.dataset.autoColor = m.content;
      m.dataset.autoMedia = m.getAttribute('media') ?? '';
    }
    if (pref === 'auto') {
      m.content = m.dataset.autoColor;
      if (m.dataset.autoMedia) m.setAttribute('media', m.dataset.autoMedia);
    } else {
      m.removeAttribute('media');
      m.content = BAR_COLOR[pref];
    }
  }
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage non disponibile: vale solo per questa sessione */
  }
  applyTheme(pref);
}
