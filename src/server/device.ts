// Riconoscimento (indicativo) del dispositivo dallo user-agent, per i messaggi all'utente.
// Lo user-agent lo dichiara il dispositivo stesso: serve a orientarsi, non è una prova di sicurezza.

/** Tipo di dispositivo: "iPhone", "telefono Android", "computer"… (usato nei messaggi di conflitto). */
export function deviceLabel(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'telefono Android' : 'tablet Android';
  if (/Windows|Macintosh|Linux|X11|CrOS/.test(ua)) return 'computer';
  return 'altro dispositivo';
}

/** Browser o app: "Safari", "Chrome", "app installata" (web app aggiunta alla Home su iPhone/iPad)… */
export function browserLabel(ua: string): string {
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/FxiOS|Firefox/.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  // su iPhone/iPad la web app aggiunta alla Home non ha il pezzo "Safari" nello user-agent
  if (/iPhone|iPad/.test(ua) && /AppleWebKit/.test(ua)) return 'app installata';
  return '';
}

/** Dispositivo e browser insieme: "iPhone, Safari". */
export function deviceDetail(ua: string): string {
  const d = deviceLabel(ua);
  const b = browserLabel(ua);
  return b ? `${d}, ${b}` : d;
}
