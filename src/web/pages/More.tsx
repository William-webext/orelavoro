import { useState } from 'preact/hooks';
import { api, type User } from '../api.ts';
import { WEEKDAY_SHORT } from '../format.ts';
import { detectPlatform, isInstalled, useInstallPrompt } from '../install.ts';
import { navigate, useSession } from '../session.tsx';
import { Icon, Sheet, toast, toastError } from '../ui.tsx';

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="switch">
      <span>
        {label}
        {hint && <div class="small muted">{hint}</div>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

function PinSheet({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [n1, setN1] = useState('');
  const [n2, setN2] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!/^\d{6,8}$/.test(n1)) return toast('Il nuovo PIN deve essere di 6-8 cifre.', 'error');
    if (n1 !== n2) return toast('I due PIN non coincidono.', 'error');
    setBusy(true);
    try {
      await api.post('/me/pin', { currentPin: cur, newPin: n1 });
      toast('PIN aggiornato');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Cambia PIN"
      onClose={onClose}
      footer={
        <button class="btn primary" disabled={busy} onClick={save}>
          Salva PIN
        </button>
      }
    >
      <div class="stack">
        <div class="field">
          <label for="p0">PIN attuale</label>
          <input id="p0" class="input" type="password" inputMode="numeric" autocomplete="current-password" value={cur} onInput={(e) => setCur(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="p1">Nuovo PIN (6-8 cifre)</label>
          <input id="p1" class="input" type="password" inputMode="numeric" autocomplete="new-password" maxLength={8} value={n1} onInput={(e) => setN1(e.currentTarget.value.replace(/\D/g, ''))} />
        </div>
        <div class="field">
          <label for="p2">Ripeti il nuovo PIN</label>
          <input id="p2" class="input" type="password" inputMode="numeric" autocomplete="new-password" maxLength={8} value={n2} onInput={(e) => setN2(e.currentTarget.value.replace(/\D/g, ''))} />
        </div>
      </div>
    </Sheet>
  );
}

export function More() {
  const { user, mailConfigured, refreshMe, logout } = useSession();
  const [name, setName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [pinOpen, setPinOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const standalone = isInstalled();
  const platform = detectPlatform();
  const installPrompt = useInstallPrompt();

  async function patch(p: Partial<Pick<User, 'displayName' | 'email' | 'autorest' | 'restWeekdays' | 'notifyOpen' | 'monthlyReport'>>, quiet = false) {
    try {
      await api.patch('/me', p);
      await refreshMe();
      if (!quiet) toast('Salvato');
    } catch (e) {
      toastError(e);
    }
  }

  async function saveProfile() {
    setSaving(true);
    await patch({ displayName: name, email });
    setSaving(false);
  }

  function toggleDay(d: number) {
    const set = new Set(user.restWeekdays);
    if (set.has(d)) set.delete(d);
    else set.add(d);
    patch({ restWeekdays: [...set].sort() }, true);
  }

  return (
    <div class="page">
      <div class="page-head">
        <h1>Altro</h1>
      </div>

      <div class="grid-2">
        <div class="stack">
          <div class="card">
            <h2>Il mio profilo</h2>
            <div class="stack">
              <div class="field">
                <label for="n">Nome</label>
                <input id="n" class="input" value={name} maxLength={60} onInput={(e) => setName(e.currentTarget.value)} />
              </div>
              <div class="field">
                <label for="m">Email (per report e promemoria)</label>
                <input id="m" class="input" type="email" inputMode="email" autocomplete="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
              </div>
              <div class="row">
                <button class="btn primary grow" disabled={saving} onClick={saveProfile}>
                  Salva
                </button>
                <button class="btn grow" onClick={() => setPinOpen(true)}>
                  Cambia PIN
                </button>
              </div>
              <div class="small muted">Utente: {user.username}</div>
            </div>
          </div>

          <div class="card">
            <h2>Notifiche via mail</h2>
            {!mailConfigured && <div class="small muted">L’invio mail non è configurato sul server.</div>}
            <Switch
              label="Promemoria uscita dimenticata"
              hint="Una mail se resti con l’ingresso aperto per molte ore."
              checked={user.notifyOpen}
              onChange={(v) => patch({ notifyOpen: v })}
            />
            <Switch
              label="Report mensile automatico"
              hint="Il 1° del mese ricevi il PDF dettagliato del mese precedente."
              checked={user.monthlyReport}
              onChange={(v) => patch({ monthlyReport: v })}
            />
            {!user.email && <div class="small muted">Inserisci la tua email qui sopra per ricevere le notifiche.</div>}
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>Giorni di riposo</h2>
            <Switch
              label="Proponi il riposo automaticamente"
              hint="I giorni scelti qui, se vuoti, non risultano “da compilare”. I turni cambiano? Puoi sempre scegliere un altro tipo per un singolo giorno."
              checked={user.autorest}
              onChange={(v) => patch({ autorest: v })}
            />
            {user.autorest && (
              <div class="chips" style={{ marginTop: 10 }}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <button key={d} class={`chip ${user.restWeekdays.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)}>
                    {WEEKDAY_SHORT[d]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div class="card">
            <h2>I miei dati</h2>
            <div class="row wrap">
              <a class="btn small" href="/api/export.csv">
                <Icon name="download" /> Turni (CSV)
              </a>
              <a class="btn small" href="/api/export.json">
                <Icon name="download" /> Tutto (JSON)
              </a>
            </div>
          </div>

          {user.role === 'superadmin' && (
            <div class="card">
              <h2>Amministrazione</h2>
              <p class="small muted" style={{ marginTop: 0 }}>
                Utenti e PIN, accesso ai dati di tutti, registro modifiche, prova mail e backup.
              </p>
              <button class="btn primary block" onClick={() => navigate('#/admin')}>
                <Icon name="users" /> Apri amministrazione
              </button>
            </div>
          )}

          {!standalone && (
            <div class="card">
              <h2>{platform === 'ios' ? 'Installa su iPhone' : platform === 'android' ? 'Installa su Android' : 'Installa l’app'}</h2>
              <div class="stack">
                {platform === 'ios' && (
                  <p class="small muted" style={{ margin: 0 }}>
                    Apri questa pagina in <b>Safari</b>, tocca <b>Condividi</b> (il quadrato con la freccia) e poi <b>Aggiungi alla schermata Home</b>. Si aprirà a schermo intero, come un’app.
                  </p>
                )}
                {platform === 'android' && (
                  <p class="small muted" style={{ margin: 0 }}>
                    Apri questa pagina in <b>Chrome</b>, tocca il menu <b>⋮</b> in alto a destra e scegli <b>Installa app</b> (o <b>Aggiungi a schermata Home</b>). Comparirà tra le tue app.
                  </p>
                )}
                {platform === 'desktop' && (
                  <p class="small muted" style={{ margin: 0 }}>
                    In Chrome o Edge clicca l’icona di installazione nella barra degli indirizzi: l’app si apre in una finestra tutta sua.
                  </p>
                )}
                {installPrompt.available && (
                  <button class="btn primary" onClick={installPrompt.install}>
                    <Icon name="download" /> Installa ora
                  </button>
                )}
              </div>
            </div>
          )}

          <button class="btn block" onClick={logout}>
            <Icon name="logout" /> Esci
          </button>
        </div>
      </div>

      {pinOpen && <PinSheet onClose={() => setPinOpen(false)} />}
    </div>
  );
}
