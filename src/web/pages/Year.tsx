import { api, type Year as YearData } from '../api.ts';
import { clockIn, dur, euro, MONTH_SHORT, rate } from '../format.ts';
import { navigate, parseHash, useSession } from '../session.tsx';
import { ErrorBox, Icon, Spinner, useLoad, useRefreshOnFocus } from '../ui.tsx';

function Bars({ values, fmt, empty }: { values: (number | null)[]; fmt: (n: number) => string; empty: string }) {
  const W = 420;
  const H = 200;
  const top = 22;
  const bottom = 26;
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  if (max === 0) return <div class="empty">{empty}</div>;
  const slot = W / values.length;
  const bw = slot * 0.62;
  const ch = H - top - bottom;
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Grafico mensile">
      <line class="grid" x1="0" x2={W} y1={H - bottom} y2={H - bottom} />
      {values.map((v, i) => {
        const x = i * slot + (slot - bw) / 2;
        const h = v ? Math.max(2, (v / max) * ch) : 0;
        return (
          <g key={i}>
            {v != null && v > 0 && (
              <>
                <rect class="bar" x={x} y={H - bottom - h} width={bw} height={h} rx="5" />
                <text class="val" x={x + bw / 2} y={H - bottom - h - 5} text-anchor="middle">
                  {fmt(v)}
                </text>
              </>
            )}
            <text x={x + bw / 2} y={H - 8} text-anchor="middle">
              {MONTH_SHORT[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Year() {
  const { tz } = useSession();
  const arg = Number(parseHash().arg);
  const thisYear = Number(clockIn(tz, Date.now()).date.slice(0, 4));
  const year = arg >= 2000 && arg <= 2100 ? arg : thisYear;
  const { data, error, loading, reload } = useLoad(() => api.get<YearData>(`/year?y=${year}`), [year]);
  useRefreshOnFocus(reload);
  const go = (n: number) => navigate(`#/anno/${year + n}`);

  return (
    <div class="page">
      <div class="page-head">
        <h1>Anno</h1>
        <div class="month-nav">
          <button class="icon-btn" onClick={() => go(-1)} aria-label="Anno precedente">
            <Icon name="left" />
          </button>
          <div class="title">{year}</div>
          <button class="icon-btn" onClick={() => go(1)} aria-label="Anno successivo">
            <Icon name="right" />
          </button>
        </div>
      </div>

      {loading && !data && <Spinner />}
      {error && !data && <ErrorBox message={error} onRetry={reload} />}

      {data && (
        <>
          <div class="stat-row">
            <div class="stat">
              <div class="v">{dur(data.totals.minutes)}</div>
              <div class="l">Ore nell’anno</div>
            </div>
            <div class="stat">
              <div class="v">{data.totals.workedDays}</div>
              <div class="l">Giorni lavorati</div>
            </div>
            <div class="stat">
              <div class="v">{rate(data.totals.rates.net)}</div>
              <div class="l">Paga oraria netta media{data.totals.paidMonths ? ` (${data.totals.paidMonths} ${data.totals.paidMonths === 1 ? 'mese' : 'mesi'})` : ''}</div>
            </div>
          </div>

          <div class="grid-2">
            <div class="card">
              <h2>Ore lavorate per mese</h2>
              <Bars values={data.months.map((m) => (m.minutes ? m.minutes : null))} fmt={(n) => dur(n).replace(/:\d\d$/, 'h')} empty="Nessuna ora registrata in questo anno." />
            </div>
            <div class="card">
              <h2>Paga oraria netta per mese</h2>
              <Bars values={data.months.map((m) => m.rates.net)} fmt={(n) => n.toFixed(2).replace('.', ',')} empty="Inserisci gli stipendi mensili per vedere la paga oraria." />
            </div>
          </div>

          <div class="card flush">
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Mese</th>
                    <th class="right">Ore</th>
                    <th class="right">Giorni</th>
                    <th class="right">Netto</th>
                    <th class="right">Lordo</th>
                    <th class="right">€/h netta</th>
                    <th class="right">€/h lorda</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m, i) => (
                    <tr key={m.ym}>
                      <td>
                        <a href={`#/mese/${m.ym}`} style={{ color: 'var(--primary)', fontWeight: 650, textDecoration: 'none' }}>
                          {MONTH_SHORT[i]}
                        </a>
                      </td>
                      <td class="num">{m.minutes ? dur(m.minutes) : '—'}</td>
                      <td class="num">{m.workedDays || '—'}</td>
                      <td class="num">{euro(m.netCents)}</td>
                      <td class="num">{euro(m.grossCents)}</td>
                      <td class="num">{rate(m.rates.net).replace(' €/h', '')}</td>
                      <td class="num">{rate(m.rates.gross).replace(' €/h', '')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Totale</td>
                    <td class="num">{dur(data.totals.minutes)}</td>
                    <td class="num">{data.totals.workedDays}</td>
                    <td class="num">{euro(data.totals.netCents)}</td>
                    <td class="num">{euro(data.totals.grossCents)}</td>
                    <td class="num">{rate(data.totals.rates.net).replace(' €/h', '')}</td>
                    <td class="num">{rate(data.totals.rates.gross).replace(' €/h', '')}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <div class="small muted">Il totale annuale di netto, lordo e paga oraria considera solo i mesi per cui hai inserito lo stipendio.</div>
        </>
      )}
    </div>
  );
}
