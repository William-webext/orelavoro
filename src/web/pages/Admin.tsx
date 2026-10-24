import { useState } from 'preact/hooks';
import { api, type AdminUser, type AuditRow } from '../api.ts';
import { navigate, useSession } from '../session.tsx';
import { confirmDialog, ErrorBox, Icon, Sheet, Spinner, toast, toastError, useLoad } from '../ui.tsx';

function UserSheet({ u, onClose, onSaved }: { u: AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(u?.username ?? '');
  const [displayName, setDisplayName] = useState(u?.displayName ?? '');
  const [email, setEmail] = useState(u?.email ?? '');
  const [role, setRole] = useState<'user' | 'superadmin'>(u?.role ?? 'user');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (u) {
        await api.patch(`/admin/users/${u.id}`, { displayName, email, role });
        if (pin) await api.post(`/admin/users/${u.id}/pin`, { pin });
      } else {
        await api.post('/admin/users', { username, displayName, email, role, pin });
      }
      toast('Salvato');
      onSaved();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={u ? `Modifica ${u.displayName}` : 'Nuovo utente'}
      onClose={onClose}
      footer={
        <button class="btn primary" disabled={busy} onClick={save}>
          Salva
        </button>
      }
    >
      <div class="stack">
        {!u && (
          <div class="field">
            <label for="a-u">Nome utente (per il login)</label>
            <input id="a-u" class="input" autocapitalize="none" autocomplete="off" value={username} onInput={(e) => setUsername(e.currentTarget.value.toLowerCase())} />
          </div>
        )}
        <div class="field">
          <label for="a-n">Nome visualizzato</label>
          <input id="a-n" class="input" value={displayName} onInput={(e) => setDisplayName(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="a-e">Email</label>
          <input id="a-e" class="input" type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="a-p">{u ? 'Nuovo PIN (lascia vuoto per non cambiarlo)' : 'PIN (6-8 cifre)'}</label>
          <input
            id="a-p"
            class="input"
            inputMode="numeric"
            maxLength={8}
            autocomplete="off"
            value={pin}
            onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
          />
        </div>
        <div class="field">
          <div class="label">Ruolo</div>
          <div class="chips">
            <button class={`chip ${role === 'user' ? 'on' : ''}`} onClick={() => setRole('user')}>
              Utente
            </button>
            <button class={`chip ${role === 'superadmin' ? 'on' : ''}`} onClick={() => setRole('superadmin')}>
              Superadmin
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

export function Admin() {
  const { user, setViewing } = useSession();
  const users = useLoad(() => api.get<{ users: AdminUser[] }>('/admin/users'), []);
  const audit = useLoad(() => api.get<{ audit: AuditRow[] }>('/admin/audit?limit=60'), []);
  const [sheet, setSheet] = useState<AdminUser | 'new' | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  function viewUser(u: AdminUser) {
    setViewing(u.id === user.id ? null : { id: u.id, displayName: u.displayName });
    navigate('#/oggi');
  }

  async function toggleActive(u: AdminUser) {
    const ok = await confirmDialog({
      title: u.active ? `Disattivare ${u.displayName}?` : `Riattivare ${u.displayName}?`,
      message: u.active ? 'Non potrà più accedere. I suoi dati restano salvati.' : 'Potrà accedere di nuovo con il suo PIN.',
      confirmLabel: u.active ? 'Disattiva' : 'Riattiva',
      danger: u.active,
    });
    if (!ok) return;
    try {
      await api.patch(`/admin/users/${u.id}`, { active: !u.active });
      users.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function unlock(u: AdminUser) {
    try {
      await api.post(`/admin/users/${u.id}/unlock`);
      toast('Utente sbloccato');
      users.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function testMail() {
    setTesting(true);
    try {
      const r = await api.post<{ to: string }>('/admin/test-mail', { to: testTo });
      toast(`Mail di prova inviata a ${r.to}`);
    } catch (e) {
      toastError(e);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div class="page">
      <div class="page-head">
        <h1>Amministrazione</h1>
        <button class="btn primary small" onClick={() => setSheet('new')}>
          <Icon name="plus" /> Utente
        </button>
      </div>

      <div class="card flush">
        {users.loading && !users.data && <Spinner />}
        {users.error && !users.data && <ErrorBox message={users.error} onRetry={users.reload} />}
        <div class="list">
          {users.data?.users.map((u) => (
            <div key={u.id} class="list-item" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div class="grow" style={{ opacity: u.active ? 1 : 0.55 }}>
                <div>
                  <b>{u.displayName}</b> {u.role === 'superadmin' && <span class="badge lavoro">superadmin</span>}{' '}
                  {!u.active && <span class="badge riposo">disattivato</span>} {u.locked && <span class="badge malattia">bloccato</span>}
                </div>
                <div class="small muted">
                  {u.username}
                  {u.email ? ` · ${u.email}` : ''}
                </div>
              </div>
              <div class="row wrap" style={{ gap: 6 }}>
                <button class="btn small" onClick={() => viewUser(u)}>
                  <Icon name="eye" /> {u.id === user.id ? 'I miei dati' : 'Vedi dati'}
                </button>
                <button class="btn small" onClick={() => setSheet(u)}>
                  <Icon name="edit" /> Modifica
                </button>
                {u.locked && (
                  <button class="btn small" onClick={() => unlock(u)}>
                    Sblocca
                  </button>
                )}
                {u.id !== user.id && (
                  <button class="btn small" onClick={() => toggleActive(u)}>
                    {u.active ? 'Disattiva' : 'Riattiva'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Registro modifiche</h2>
          <p class="small muted" style={{ marginTop: -6 }}>
            Cosa è stato modificato dal superadmin sui dati di altri utenti.
          </p>
          {audit.data?.audit.length === 0 && <div class="empty">Nessuna modifica registrata.</div>}
          <div class="stack tight">
            {audit.data?.audit.map((a) => (
              <div key={a.id} class="small" style={{ paddingBottom: 6, borderBottom: '1px solid var(--line)' }}>
                <div class="muted">{new Date(a.ts).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</div>
                <div>
                  <b>{a.actor}</b> → {a.target || '—'}: {a.action}
                </div>
                {a.detail && <div class="muted">{a.detail}</div>}
              </div>
            ))}
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>Mail di prova</h2>
            <div class="stack">
              <div class="field">
                <label for="t-to">Destinatario (vuoto = la tua email)</label>
                <input id="t-to" class="input" type="email" value={testTo} onInput={(e) => setTestTo(e.currentTarget.value)} />
              </div>
              <button class="btn" disabled={testing} onClick={testMail}>
                <Icon name="mail" /> {testing ? 'Invio…' : 'Invia mail di prova'}
              </button>
            </div>
          </div>
          <div class="card">
            <h2>Backup</h2>
            <p class="small muted" style={{ marginTop: -6 }}>
              Una copia automatica del database viene salvata ogni notte in <code>/data/backups</code>. Qui puoi scaricarne una subito.
            </p>
            <a class="btn" href="/api/admin/backup">
              <Icon name="download" /> Scarica database
            </a>
          </div>
        </div>
      </div>

      {sheet && <UserSheet u={sheet === 'new' ? null : sheet} onClose={() => setSheet(null)} onSaved={() => { users.reload(); audit.reload(); }} />}
    </div>
  );
}
