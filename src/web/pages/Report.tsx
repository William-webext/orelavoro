import { useEffect, useState } from 'preact/hooks';
import { api, DAY_TYPE_LABEL, type Month as MonthData, type Salary } from '../api.ts';
import { addMonths, clockIn, dur, euro, itDate, monthLabel, moneyInput, parseMoney, rate, WEEKDAY_SHORT } from '../format.ts';
import { navigate, parseHash, useSession } from '../session.tsx';
import { ErrorBox, Icon, MonthNav, Spinner, toast, toastError, useLoad } from '../ui.tsx';

interface ReportData {
  report: { user: { id: number; name: string }; ym: string; label: string; month: MonthData; salary: Salary };
}

export function Report() {
  const { tz, user, mailConfigured } = useSession();
  const arg = parseHash().arg;
  const thisYm = clockIn(tz, Date.now()).date.slice(0, 7);
  const ym = /^\d{4}-\d{2}$/.test(arg) ? arg : addMonths(thisYm, 0);
  const { data, error, loading, reload } = useLoad(() => api.get<ReportData>(`/report?ym=${ym}`), [ym]);

  const [net, setNet] = useState('');
  const [gross, setGross] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [mailDetail, setMailDetail] = useState(false);
  const [mailFormat, setMailFormat] = useState<'pdf' | 'xlsx'>('pdf');
  const [sending, setSending] = useState(false);

  const r = data?.report;
  useEffect(() => {
    if (!r) return;
    setNet(moneyInput(r.salary.netCents));
    setGross(moneyInput(r.salary.grossCents));
    setNote(r.salary.note);
  }, [r?.salary.netCents, r?.salary.grossCents, r?.salary.note, r?.ym]);

  const go = (n: number) => navigate(`#/report/${addMonths(ym, n)}`);
  if (loading && !r) return <Spinner />;
  if (error && !r) return <ErrorBox message={error} onRetry={reload} />;
  if (!r) return null;

  const t = r.month.totals;
  const hours = t.minutes / 60;
  const netC = parseMoney(net);
  const grossC = parseMoney(gross);
  const liveNet = netC != null && !Number.isNaN(netC) && hours > 0 ? netC / 100 / hours : null;
  const liveGross = grossC != null && !Number.isNaN(grossC) && hours > 0 ? grossC / 100 / hours : null;
  const incomplete = t.todoDays > 0 || t.openEntries > 0;
  const isCurrent = ym >= thisYm;

  async function saveSalary() {
    if (Number.isNaN(netC) || Number.isNaN(grossC)) {
      toast('Importo non valido. Esempio: 1.234,56', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.put('/salary', { ym, netCents: netC, grossCents: netC == null ? null : grossC, note });
      toast(netC == null ? 'Stipendio rimosso' : 'Stipendio salvato');
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }

  async function sendMail() {
    setSending(true);
    try {
      const res = await api.post<{ to: string }>('/report/email', { ym, detail: mailDetail, format: mailFormat });
      toast(`Report inviato a ${res.to}`);
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  }

  const dl = (detail: boolean, format: 'pdf' | 'xlsx') => api.fileUrl(`/report/file?ym=${ym}&detail=${detail ? 1 : 0}&format=${format}`);

  return (
    <div class="page">
      <div class="page-head">
        <h1>Stipendio e report</h1>
      </div>
      <div class="row between wrap">
        <MonthNav label={monthLabel(ym)} onPrev={() => go(-1)} onNext={() => go(1)} onToday={() => navigate('#/report')} />
        <span class="muted small">{r.user.name}</span>
      </div>

      {incomplete && (
        <div class="banner">
          <Icon name="alert" />
          <div>
            {isCurrent ? 'Il mese non è ancora completo' : 'Il mese non è completo'}
            {t.todoDays > 0 && `: ${t.todoDays} giorni da compilare`}
            {t.openEntries > 0 && `, ${t.openEntries} ingresso senza uscita`}. La paga oraria è provvisoria.
          </div>
        </div>
      )}

      <div class="grid-2">
        <div class="stack">
          <div class="card">
            <h2>Stipendio ricevuto</h2>
            <div class="stack">
              <div class="fields-2">
                <div class="field">
                  <label for="s-net">Netto in busta (€)</label>
                  <input id="s-net" class="input" inputMode="decimal" placeholder="es. 1.250,00" value={net} onInput={(e) => setNet(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label for="s-gross">Lordo (€, facoltativo)</label>
                  <input id="s-gross" class="input" inputMode="decimal" placeholder="es. 1.600,00" value={gross} onInput={(e) => setGross(e.currentTarget.value)} />
                </div>
              </div>
              <div class="field">
                <label for="s-note">Nota</label>
                <input id="s-note" class="input" maxLength={200} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
              </div>
              <div class="rate-box">
                <div class="rate">
                  <div class="v">{rate(liveNet)}</div>
                  <div class="l">Paga oraria netta</div>
                </div>
                <div class="rate" style={liveGross == null ? { opacity: 0.5 } : undefined}>
                  <div class="v">{rate(liveGross)}</div>
                  <div class="l">Paga oraria lorda</div>
                </div>
              </div>
              <div class="small muted">
                = stipendio ÷ ore lavorate ({dur(t.minutes)} = {hours.toFixed(2).replace('.', ',')} h)
              </div>
              <button class="btn primary" onClick={saveSalary} disabled={saving}>
                {saving ? 'Salvo…' : 'Salva stipendio'}
              </button>
            </div>
          </div>

          <div class="card">
            <h2>Scarica o invia</h2>
            <div class="stack">
              <div class="row wrap">
                <a class="btn small" href={dl(false, 'pdf')} target="_blank" rel="noopener">
                  <Icon name="download" /> PDF sintetico
                </a>
                <a class="btn small" href={dl(true, 'pdf')} target="_blank" rel="noopener">
                  <Icon name="download" /> PDF dettagliato
                </a>
                <a class="btn small" href={dl(false, 'xlsx')} target="_blank" rel="noopener">
                  <Icon name="download" /> Excel sintetico
                </a>
                <a class="btn small" href={dl(true, 'xlsx')} target="_blank" rel="noopener">
                  <Icon name="download" /> Excel dettagliato
                </a>
              </div>
              {mailConfigured ? (
                <>
                  <div class="hr" />
                  <div class="field">
                    <div class="label">Invia per mail{user.email ? ` a ${user.email}` : ''}</div>
                    <div class="chips">
                      <button class={`chip ${!mailDetail ? 'on' : ''}`} onClick={() => setMailDetail(false)}>
                        Sintetico
                      </button>
                      <button class={`chip ${mailDetail ? 'on' : ''}`} onClick={() => setMailDetail(true)}>
                        Dettagliato
                      </button>
                      <button class={`chip ${mailFormat === 'pdf' ? 'on' : ''}`} onClick={() => setMailFormat('pdf')}>
                        PDF
                      </button>
                      <button class={`chip ${mailFormat === 'xlsx' ? 'on' : ''}`} onClick={() => setMailFormat('xlsx')}>
                        Excel
                      </button>
                    </div>
                  </div>
                  {!user.email && <div class="small muted">Imposta il tuo indirizzo email in “Altro” per ricevere i report.</div>}
                  <button class="btn" onClick={sendMail} disabled={sending || !user.email}>
                    <Icon name="mail" /> {sending ? 'Invio…' : 'Invia report'}
                  </button>
                </>
              ) : (
                <div class="small muted">L’invio per mail non è configurato sul server.</div>
              )}
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>Sintesi di {monthLabel(ym)}</h2>
            <div class="kv">
              <div class="k">Ore totali</div>
              <div class="v">{dur(t.minutes)}</div>
              <div class="k">Giorni lavorati</div>
              <div class="v">{t.workedDays}</div>
              <div class="k">Media per giorno lavorato</div>
              <div class="v">{dur(t.avgMinutesPerWorkedDay)}</div>
              {(['ferie', 'malattia', 'permesso', 'festivo', 'riposo'] as const).map((k) => (
                <>
                  <div class="k">{DAY_TYPE_LABEL[k]}</div>
                  <div class="v">{t.byType[k]} gg</div>
                </>
              ))}
              <div class="k">Giorni da compilare</div>
              <div class="v" style={t.todoDays ? { color: 'var(--danger)' } : undefined}>
                {t.todoDays}
              </div>
              <div class="k">Stipendio netto</div>
              <div class="v">{euro(r.salary.netCents)}</div>
              {r.salary.grossCents != null && (
                <>
                  <div class="k">Stipendio lordo</div>
                  <div class="v">{euro(r.salary.grossCents)}</div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div class="card flush">
        <details>
          <summary style={{ padding: '14px 16px', fontWeight: 700, cursor: 'pointer' }}>Dettaglio giorno per giorno</summary>
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Giorno</th>
                  <th>Tipo</th>
                  <th>Turni</th>
                  <th class="right">Totale</th>
                </tr>
              </thead>
              <tbody>
                {r.month.days.map((d) => (
                  <tr key={d.date}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {itDate(d.date).slice(0, 5)} <span class="muted">{WEEKDAY_SHORT[d.weekday]}</span>
                    </td>
                    <td>{d.type ? DAY_TYPE_LABEL[d.type] : d.entries.length ? 'Lavoro' : d.autoRest ? 'Riposo' : d.todo ? <span style={{ color: 'var(--danger)' }}>Da compilare</span> : ''}</td>
                    <td>{d.entries.map((e) => `${e.start}–${e.end ?? '…'}`).join('  ')}</td>
                    <td class="num">{d.minutes ? dur(d.minutes) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Totale mese</td>
                  <td class="num">{dur(t.minutes)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}
