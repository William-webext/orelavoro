import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Entry, type Status, type Warning } from '../api.ts';
import { cacheStatus, cachedStatus, correctedNow, discardPunch, flush, noteServerTime, punch, retryPunch, usePunchQueue, useReachable, type QueuedPunch } from '../offline.ts';
import { clockIn, dayLong, dur, durLong, itDate, monthLabel } from '../format.ts';
import { navigate, useSession } from '../session.tsx';
import { DayTypeChips, EntrySheet } from '../sheets.tsx';
import { ErrorBox, Icon, Spinner, toast, toastError, useLoad } from '../ui.tsx';

interface Loaded {
  st: Status;
  /** dati dall'ultima volta che il server era raggiungibile */
  stale: boolean;
}

/** Ingresso aperto "effettivo": quello del server più le timbrature in attesa di invio. */
function effectiveOpen(st: Status, pending: QueuedPunch[]): { startEpoch: number } | null {
  let open = st.open ? { startEpoch: st.now.epochMs - st.open.elapsedMinutes * 60000 } : null;
  for (const p of pending) open = p.kind === 'in' ? { startEpoch: p.at } : null;
  return open;
}

export function Today() {
  const { tz, user, subject, viewing } = useSession();
  const own = !viewing;
  const reachable = useReachable();
  const queue = usePunchQueue(user.id);
  const pending = own ? queue.pending : [];
  const failed = own ? queue.failed : [];

  const { data, error, loading, reload } = useLoad<Loaded>(async () => {
    if (own) await flush(user.id);
    try {
      const st = await api.get<Status>('/status', { timeoutMs: 12000 });
      if (own) {
        cacheStatus(user.id, st);
        noteServerTime(st.now.epochMs);
      }
      return { st, stale: false };
    } catch (e) {
      if (own && e instanceof ApiError && e.status === 0) {
        const cached = cachedStatus(user.id);
        if (cached) return { st: cached, stale: true };
      }
      throw e;
    }
  }, []);

  const [, setTick] = useState(0);
  const [sheet, setSheet] = useState<{ entry?: Entry; date?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // orologio che scorre + aggiornamento quando l'app torna in primo piano (promemoria!)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    const onVis = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // appena la coda si svuota (sincronizzazione riuscita) o il server torna, ricarica
  const prevPending = useRef(pending.length);
  useEffect(() => {
    if (prevPending.current > pending.length) reload();
    prevPending.current = pending.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);
  const prevReachable = useRef(reachable);
  useEffect(() => {
    if (!prevReachable.current && reachable) reload();
    prevReachable.current = reachable;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const { st, stale } = data;
  const nowMs = correctedNow();
  const clk = clockIn(tz, nowMs);
  const todayDate = clk.date;
  const open = effectiveOpen(st, pending);
  const elapsed = open ? Math.max(0, Math.floor((nowMs - open.startEpoch) / 60000)) : 0;
  const openAt = open ? clockIn(tz, open.startEpoch) : null;
  const todayDay = st.today;
  const openIsToday = openAt?.date === todayDate;
  const offlineMode = stale || !reachable;

  async function clock(kind: 'in' | 'out') {
    setBusy(true);
    try {
      const r = await punch(kind, user.id, own);
      if (r === 'queued') {
        toast(`${kind === 'in' ? 'Entrata' : 'Uscita'} salvata sul telefono: verrà registrata appena il server è raggiungibile`);
      } else {
        toast(kind === 'in' ? 'Entrata registrata' : 'Uscita registrata');
        await reload();
      }
    } catch (e) {
      toastError(e);
      if (kind === 'out' && e instanceof ApiError && e.status === 422 && st.open) setSheet({ entry: st.open });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function warningAction(w: Warning) {
    if (w.kind === 'open_stale' || w.kind === 'open_old') {
      if (st.open) setSheet({ entry: st.open });
    } else if (w.date) {
      navigate(`#/mese/${w.date.slice(0, 7)}`);
    } else {
      navigate('#/mese');
    }
  }

  const punchLabel = (p: QueuedPunch) => {
    const c = clockIn(tz, p.at);
    return `${p.kind === 'in' ? 'Entrata' : 'Uscita'} ${c.time}${c.date !== todayDate ? ` del ${itDate(c.date).slice(0, 5)}` : ''}`;
  };

  const ymNow = todayDate.slice(0, 7);

  return (
    <div class="page">
      <div class="page-head">
        <h1>Oggi</h1>
        <span class="muted small">{subject.displayName}</span>
      </div>

      {offlineMode && (
        <div class="banner info">
          <Icon name="alert" />
          <div>
            Server non raggiungibile. Puoi timbrare lo stesso: ingresso e uscita restano sul telefono e vengono registrati appena possibile.
            {stale && <div class="small">Dati dell’ultimo collegamento.</div>}
            <div>
              <button class="btn small" onClick={reload}>
                Riprova ora
              </button>
            </div>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div class="card" style={{ borderColor: 'var(--primary)' }}>
          <h2>In attesa di invio ({pending.length})</h2>
          <div class="stack tight">
            {pending.map((p) => (
              <div key={p.clientId} class="row between">
                <b>{punchLabel(p)}</b>
                <span class="badge auto">sul telefono</span>
              </div>
            ))}
          </div>
          <p class="small muted" style={{ marginBottom: 0 }}>
            L’ora è quella del tocco. Saranno registrate in automatico quando il server torna raggiungibile.
          </p>
        </div>
      )}

      {failed.length > 0 && (
        <div class="banner danger">
          <Icon name="alert" />
          <div>
            <b>Timbrature non registrate dal server</b>
            {failed.map((p) => (
              <div key={p.clientId} style={{ marginTop: 8 }}>
                {punchLabel(p)}: {p.error}
                <div class="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  <button class="btn small" onClick={() => setSheet({ date: clockIn(tz, p.at).date })}>
                    Inserisci a mano
                  </button>
                  <button class="btn small" onClick={() => { retryPunch(p.clientId); reload(); }}>
                    Riprova
                  </button>
                  <button class="btn small" onClick={() => discardPunch(p.clientId)}>
                    Scarta
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {st.warnings.map((w, i) => (
        <div key={i} class={`banner ${w.kind === 'open_stale' ? 'danger' : ''}`}>
          <Icon name="alert" />
          <div>
            {w.message}
            <div>
              <button class="btn small" onClick={() => warningAction(w)}>
                {w.kind === 'open_stale' || w.kind === 'open_old' ? 'Completa l’uscita' : w.kind === 'missing_days' ? 'Vai al mese' : 'Controlla'}
              </button>
            </div>
          </div>
        </div>
      ))}

      <div class="grid-2">
        <div class="stack">
          <div class="card clock-card">
            <div class="clock-time">{clk.time}</div>
            <div class="clock-date">{dayLong(clk.date)}</div>
            <div class={`clock-status ${open ? 'on' : 'muted'}`}>
              {open && openAt ? (
                <>
                  <span class="pulse" />
                  In servizio dalle {openAt.time}
                  {!openIsToday && ` del ${itDate(openAt.date).slice(0, 5)}`} · {durLong(elapsed)}
                </>
              ) : (
                'Non sei in servizio'
              )}
            </div>
            {open ? (
              <button class="btn big out" disabled={busy} onClick={() => clock('out')}>
                <Icon name="stop" /> Timbra uscita
              </button>
            ) : (
              <button class="btn big in" disabled={busy} onClick={() => clock('in')}>
                <Icon name="play" /> Timbra entrata
              </button>
            )}
          </div>

          <div class="stat-row">
            <div class="stat">
              <div class="v">{dur(todayDay.minutes + (open && openIsToday ? elapsed : 0))}</div>
              <div class="l">Ore oggi</div>
            </div>
            <div class="stat">
              <div class="v">{dur(st.monthMinutes)}</div>
              <div class="l">Ore {monthLabel(ymNow).split(' ')[0]}</div>
            </div>
            <div class="stat">
              <div class="v">{todayDay.entries.length}</div>
              <div class="l">Turni oggi</div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="row between" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Turni di oggi</h2>
              <button class="btn small" disabled={offlineMode} onClick={() => setSheet({ date: todayDate })}>
                <Icon name="plus" /> Aggiungi
              </button>
            </div>
            {todayDay.entries.length === 0 ? (
              <div class="empty" style={{ padding: '14px 0' }}>
                Nessun turno registrato oggi.
              </div>
            ) : (
              <div class="list" style={{ margin: '0 -16px' }}>
                {todayDay.entries.map((e) => (
                  <button key={e.id} class="list-item" disabled={offlineMode} onClick={() => setSheet({ entry: e })}>
                    <div class="grow">
                      <div class="shift-time">
                        {e.start} – {e.end ?? 'in corso'}
                        {e.nextDay && <span class="muted small"> (+1)</span>}
                        {e.offline && <span class="badge auto" style={{ marginLeft: 8 }}>offline</span>}
                      </div>
                      {e.note && <div class="small muted">{e.note}</div>}
                    </div>
                    <b>{e.open ? durLong(elapsed) : dur(e.minutes)}</b>
                    <Icon name="edit" size={18} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div class="card">
            <h2>Tipo di giornata</h2>
            <DayTypeChips date={todayDate} type={todayDay.type} onChanged={reload} />
            <p class="small muted" style={{ marginBottom: 0 }}>
              Se oggi non lavori, segna ferie, malattia, permesso, festivo o riposo: ogni giorno del mese deve avere una registrazione.
            </p>
          </div>
        </div>
      </div>

      {sheet && <EntrySheet entry={sheet.entry} date={sheet.date} onClose={() => setSheet(null)} onSaved={reload} />}
    </div>
  );
}
