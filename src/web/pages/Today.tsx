import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Entry, type Status, type Warning } from '../api.ts';
import { clockIn, dayLong, dur, durLong, monthLabel } from '../format.ts';
import { navigate, useSession } from '../session.tsx';
import { DayTypeChips, EntrySheet } from '../sheets.tsx';
import { ErrorBox, Icon, Spinner, toast, toastError, useLoad } from '../ui.tsx';

export function Today() {
  const { tz, subject } = useSession();
  const fetchedAt = useRef(Date.now());
  const { data: st, error, loading, reload } = useLoad(async () => {
    const s = await api.get<Status>('/status');
    fetchedAt.current = Date.now();
    return s;
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

  if (loading && !st) return <Spinner />;
  if (error && !st) return <ErrorBox message={error} onRetry={reload} />;
  if (!st) return null;

  const skew = st.now.epochMs - fetchedAt.current;
  const clk = clockIn(tz, Date.now() + skew);
  const sinceFetch = Math.floor((Date.now() - fetchedAt.current) / 60000);
  const elapsed = st.open ? st.open.elapsedMinutes + sinceFetch : 0;
  const todayDay = st.today;
  const liveMinutes = todayDay.minutes;

  async function clock(kind: 'in' | 'out') {
    setBusy(true);
    try {
      await api.post(`/clock/${kind}`);
      toast(kind === 'in' ? 'Entrata registrata' : 'Uscita registrata');
      await reload();
    } catch (e) {
      toastError(e);
      if (kind === 'out' && e instanceof ApiError && e.status === 422 && st?.open) setSheet({ entry: st.open });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function warningAction(w: Warning) {
    if (w.kind === 'open_stale' || w.kind === 'open_old') {
      if (st?.open) setSheet({ entry: st.open });
    } else if (w.date) {
      navigate(`#/mese/${w.date.slice(0, 7)}`);
    } else {
      navigate('#/mese');
    }
  }

  const ymNow = st.now.date.slice(0, 7);

  return (
    <div class="page">
      <div class="page-head">
        <h1>Oggi</h1>
        <span class="muted small">{subject.displayName}</span>
      </div>

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
            <div class={`clock-status ${st.open ? 'on' : 'muted'}`}>
              {st.open ? (
                <>
                  <span class="pulse" />
                  In servizio dalle {st.open.start}
                  {st.open.date !== st.now.date && ` del ${st.open.date.split('-').reverse().slice(0, 2).join('/')}`} · {durLong(elapsed)}
                </>
              ) : (
                'Non sei in servizio'
              )}
            </div>
            {st.open ? (
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
              <div class="v">{dur(liveMinutes + (st.open && st.open.date === st.now.date ? elapsed : 0))}</div>
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
              <button class="btn small" onClick={() => setSheet({ date: st.now.date })}>
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
                  <button key={e.id} class="list-item" onClick={() => setSheet({ entry: e })}>
                    <div class="grow">
                      <div class="shift-time">
                        {e.start} – {e.end ?? 'in corso'}
                        {e.nextDay && <span class="muted small"> (+1)</span>}
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
            <DayTypeChips date={st.now.date} type={todayDay.type} onChanged={reload} />
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
