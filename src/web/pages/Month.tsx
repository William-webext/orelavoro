import { useState } from 'preact/hooks';
import { api, DAY_TYPE_LABEL, type Day, type Month as MonthData } from '../api.ts';
import { addMonths, clockIn, dur, monthLabel, WEEKDAY_SHORT, parts } from '../format.ts';
import { navigate, parseHash, useSession } from '../session.tsx';
import { DaySheet } from '../sheets.tsx';
import { confirmDialog, ErrorBox, Icon, MonthNav, Spinner, toast, toastError, useLoad } from '../ui.tsx';

export function dayBadge(d: Day) {
  if (d.type) return <span class={`badge ${d.type}`}>{DAY_TYPE_LABEL[d.type]}</span>;
  if (d.entries.length) return <span class="badge lavoro">Lavoro</span>;
  if (d.autoRest) return <span class="badge auto">Riposo (auto)</span>;
  if (d.todo) return <span class="badge todo">Da compilare</span>;
  if (d.today) return <span class="badge auto">Oggi</span>;
  return null;
}

export function Month() {
  const arg = parseHash().arg;
  const { tz } = useSession();
  const thisYm = clockIn(tz, Date.now()).date.slice(0, 7);
  const ym = /^\d{4}-\d{2}$/.test(arg) ? arg : thisYm;
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => api.get<{ month: MonthData }>(`/month?ym=${ym}`), [ym]);

  const go = (n: number) => navigate(`#/mese/${addMonths(ym, n)}`);
  const month = data?.month;
  const selectedDay = month?.days.find((d) => d.date === selected) ?? null;

  async function fill() {
    if (!month) return;
    const ok = await confirmDialog({
      title: 'Segnare i giorni vuoti come riposo?',
      message: `${month.totals.todoDays} giorni passati senza alcuna registrazione verranno segnati come "Riposo". Potrai cambiarli uno a uno.`,
      confirmLabel: 'Segna come riposo',
    });
    if (!ok) return;
    try {
      const r = await api.post<{ filled: number }>('/daytype/fill', { ym });
      toast(`${r.filled} giorni segnati come riposo`);
      reload();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div class="page">
      <div class="page-head">
        <h1>Mese</h1>
        <MonthNav label={monthLabel(ym)} onPrev={() => go(-1)} onNext={() => go(1)} onToday={() => navigate('#/mese')} />
      </div>

      {loading && !month && <Spinner />}
      {error && !month && <ErrorBox message={error} onRetry={reload} />}

      {month && (
        <>
          <div class="stat-row">
            <div class="stat">
              <div class="v">{dur(month.totals.minutes)}</div>
              <div class="l">Ore totali</div>
            </div>
            <div class="stat">
              <div class="v">{month.totals.workedDays}</div>
              <div class="l">Giorni lavorati</div>
            </div>
            <div class="stat">
              <div class="v" style={month.totals.todoDays ? { color: 'var(--danger)' } : undefined}>
                {month.totals.todoDays}
              </div>
              <div class="l">Da compilare</div>
            </div>
          </div>

          {month.totals.todoDays > 0 && (
            <div class="banner info">
              <Icon name="alert" />
              <div>
                {month.totals.todoDays === 1 ? '1 giorno passato non ha' : `${month.totals.todoDays} giorni passati non hanno`} nessuna registrazione.
                <div>
                  <button class="btn small" onClick={fill}>
                    Segna i giorni vuoti come riposo
                  </button>
                </div>
              </div>
            </div>
          )}

          <div class="card flush">
            <div class="list">
              {month.days.map((d) => {
                const { d: num } = parts(d.date);
                const weekend = d.weekday === 0 || d.weekday === 6;
                return (
                  <button
                    key={d.date}
                    class={`day-row ${weekend ? 'weekend' : ''} ${d.today ? 'today' : ''} ${d.future ? 'future' : ''}`}
                    onClick={() => setSelected(d.date)}
                  >
                    <div>
                      <div class="day-num">{num}</div>
                      <div class="day-wd">{WEEKDAY_SHORT[d.weekday]}</div>
                    </div>
                    <div class="day-mid">
                      <div class="row wrap" style={{ gap: 6 }}>
                        {dayBadge(d)}
                        {d.warnings.length > 0 && <span class="warn-dot">⚠ da controllare</span>}
                      </div>
                      {d.entries.length > 0 && (
                        <div class="day-shifts">{d.entries.map((e) => `${e.start}–${e.end ?? '…'}${e.nextDay ? ' (+1)' : ''}`).join('  ·  ')}</div>
                      )}
                    </div>
                    <div class="day-total">{d.minutes ? dur(d.minutes) : ''}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {selectedDay && <DaySheet day={selectedDay} onClose={() => setSelected(null)} onChanged={reload} />}
    </div>
  );
}
