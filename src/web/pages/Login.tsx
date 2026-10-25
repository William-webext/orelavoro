import { useState } from 'preact/hooks';
import { api, type User } from '../api.ts';

export function Login({ onLogin, notice }: { onLogin: (u: User) => void; notice?: string }) {
  let saved = '';
  try {
    saved = localStorage.getItem('ol_username') ?? '';
  } catch {
    /* storage non disponibile */
  }
  const [username, setUsername] = useState(saved);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!username.trim() || !pin) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ user: User }>('/login', { username, pin });
      try {
        localStorage.setItem('ol_username', username.trim().toLowerCase());
      } catch {
        /* ignora */
      }
      onLogin(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login">
      <form class="login-card stack" onSubmit={submit}>
        <img class="login-logo" src="/icon-192.png" alt="" />
        <div class="center">
          <h1>Ore Lavoro</h1>
          <div class="muted">Accedi con utente e PIN</div>
        </div>
        {notice && (
          <div class="banner info" role="status">
            <div>{notice}</div>
          </div>
        )}
        <div class="card stack">
          <div class="field">
            <label for="l-user">Utente</label>
            <input
              id="l-user"
              class="input"
              autocapitalize="none"
              autocorrect="off"
              autocomplete="username"
              value={username}
              onInput={(e) => setUsername(e.currentTarget.value)}
              autofocus={!saved}
            />
          </div>
          <div class="field">
            <label for="l-pin">PIN</label>
            <input
              id="l-pin"
              class="input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autocomplete="current-password"
              value={pin}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
              autofocus={!!saved}
              style={{ letterSpacing: '0.3em', textAlign: 'center', fontSize: 22 }}
            />
          </div>
          <div class="error-text" role="alert">
            {error}
          </div>
          <button class="btn primary big" style={{ minHeight: 52 }} disabled={busy || !username || pin.length < 6}>
            {busy ? 'Accesso…' : 'Entra'}
          </button>
        </div>
      </form>
    </div>
  );
}
