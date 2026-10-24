import { render, type JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import './styles.css';
import { api, getViewAs, onUnauthorized, setViewAs, type Status, type User } from './api.ts';
import { Admin } from './pages/Admin.tsx';
import { Login } from './pages/Login.tsx';
import { Month } from './pages/Month.tsx';
import { More } from './pages/More.tsx';
import { Report } from './pages/Report.tsx';
import { Today } from './pages/Today.tsx';
import { Year } from './pages/Year.tsx';
import { navigate, parseHash, SessionContext, type Person, type Session } from './session.tsx';
import { Icon, Overlays, Spinner } from './ui.tsx';

const NAV = [
  { page: 'oggi', label: 'Oggi', icon: 'clock' },
  { page: 'mese', label: 'Mese', icon: 'calendar' },
  { page: 'report', label: 'Report', icon: 'report' },
  { page: 'anno', label: 'Anno', icon: 'chart' },
  { page: 'altro', label: 'Altro', icon: 'more' },
];

interface MeResponse {
  user: User;
  mailConfigured: boolean;
  tz: string;
}

function App() {
  const [me, setMe] = useState<MeResponse | null | 'loading'>('loading');
  const [viewing, setViewingState] = useState<Person | null>(null);
  const [route, setRoute] = useState(parseHash());

  useEffect(() => {
    const f = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const r = await api.get<MeResponse>('/me');
      setMe(r);
      // se era attivo "visualizza come", recupera il nome dell'utente osservato
      if (getViewAs() != null) {
        try {
          const st = await api.get<Status>('/status');
          setViewingState(st.target.id === r.user.id ? null : { id: st.target.id, displayName: st.target.displayName });
          if (st.target.id === r.user.id) setViewAs(null);
        } catch {
          setViewAs(null);
          setViewingState(null);
        }
      }
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    refreshMe();
    return onUnauthorized(() => setMe(null));
  }, [refreshMe]);

  if (me === 'loading') return <Spinner />;
  if (me === null) {
    return (
      <>
        <Login
          onLogin={() => {
            setViewAs(null);
            setViewingState(null);
            if (!location.hash) navigate('#/oggi');
            refreshMe();
          }}
        />
        <Overlays />
      </>
    );
  }

  const session: Session = {
    user: me.user,
    viewing,
    subject: viewing ?? me.user,
    tz: me.tz,
    mailConfigured: me.mailConfigured,
    setViewing: (p) => {
      setViewAs(p ? p.id : null);
      setViewingState(p);
    },
    refreshMe,
    logout: async () => {
      try {
        await api.post('/logout');
      } catch {
        /* ignora */
      }
      setViewAs(null);
      setViewingState(null);
      setMe(null);
    },
  };

  const isAdmin = me.user.role === 'superadmin';
  let page: JSX.Element;
  switch (route.page) {
    case 'mese':
      page = <Month />;
      break;
    case 'report':
      page = <Report />;
      break;
    case 'anno':
      page = <Year />;
      break;
    case 'altro':
      page = <More />;
      break;
    case 'admin':
      page = isAdmin ? <Admin /> : <Today />;
      break;
    default:
      page = <Today />;
  }
  const active = route.page === 'admin' ? 'altro' : NAV.some((n) => n.page === route.page) ? route.page : 'oggi';
  // ricrea la pagina quando cambia l'utente osservato o il parametro di rotta
  const pageKey = `${route.page}:${route.arg}:${viewing?.id ?? 0}`;

  return (
    <SessionContext.Provider value={session}>
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <img src="/icon-192.png" alt="" /> Ore Lavoro
          </div>
          {NAV.map((n) => (
            <a key={n.page} class={`side-link ${active === n.page ? 'active' : ''}`} href={`#/${n.page}`}>
              <Icon name={n.icon} /> {n.label}
            </a>
          ))}
          <div class="side-foot">
            <div>
              <b>{me.user.displayName}</b>
            </div>
            <div class="muted small">{me.user.role === 'superadmin' ? 'Superadmin' : 'Utente'}</div>
          </div>
        </aside>

        <main class="main">
          {viewing && (
            <div class="viewing">
              <span>Stai vedendo i dati di {viewing.displayName}</span>
              <button
                onClick={() => {
                  session.setViewing(null);
                }}
              >
                Torna ai miei
              </button>
            </div>
          )}
          <div key={pageKey}>{page}</div>
        </main>

        <nav class="tabbar" aria-label="Navigazione">
          {NAV.map((n) => (
            <a key={n.page} class={`tab ${active === n.page ? 'active' : ''}`} href={`#/${n.page}`}>
              <Icon name={n.icon} />
              {n.label}
            </a>
          ))}
        </nav>
        <Overlays />
      </div>
    </SessionContext.Provider>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* l'app funziona anche senza service worker */
    });
  });
}
