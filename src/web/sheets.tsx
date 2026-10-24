import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { api, DAY_TYPE_LABEL, DAY_TYPES, type Day, type DayType, type Entry } from './api.ts';
import { dayLong, dur, durLong, itDate, previewMinutes } from './format.ts';
import { confirmDialog, Icon, Sheet, toast, toastError } from './ui.tsx';

interface Change {
  date: string;
  before: number;
  after: number;
}

function changeLines(changes: Change[]): JSX.Element {
  return (
    <div class="stack tight">
      {changes.map((c) =>
        c.before === c.after ? (
          <div key={c.date}>
            Il totale del <b>{itDate(c.date)}</b> non cambia (<b>{dur(c.after)}</b>).
          </div>
        ) : (
          <div key={c.date}>
            Attenzione: il totale ore del <b>{itDate(c.date)}</b> passa da <b>{dur(c.before)}</b> a <b>{dur(c.after)}</b>.
          </div>
        ),
      )}
    </div>
  );
}

/** Aggiunta / modifica / eliminazione di un singolo turno. */
export function EntrySheet({
  entry,
  date,
  onClose,
  onSaved,
}: {
  entry?: Entry;
  date?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState(entry?.date ?? date ?? '');
  const [start, setStart] = useState(entry?.start ?? '');
  const [end, setEnd] = useState(entry?.end ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [busy, setBusy] = useState(false);

  const calc = start && end ? previewMinutes(start, end) : null;

  async function save() {
    if (!d || !start) {
      toast('Inserisci data e ora di inizio.', 'error');
      return;
    }
    setBusy(true);
    try {
      const payload = { date: d, start, end: end || null, note };
      if (entry) {
        const pv = await api.post<{ changes: Change[] }>('/entries/preview', { id: entry.id, date: d, start, end: end || null });
        const ok = await confirmDialog({ title: 'Confermi la modifica?', message: changeLines(pv.changes), confirmLabel: 'Conferma modifica' });
        if (!ok) return;
        await api.put(`/entries/${entry.id}`, payload);
      } else {
        await api.post('/entries', payload);
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

  async function remove() {
    if (!entry) return;
    setBusy(true);
    try {
      const pv = await api.post<{ changes: Change[] }>('/entries/preview', { id: entry.id, delete: true });
      const ok = await confirmDialog({
        title: 'Eliminare questo turno?',
        message: (
          <div class="stack">
            <div>
              Turno {entry.start}–{entry.end ?? 'in corso'} del {itDate(entry.date)}.
            </div>
            {changeLines(pv.changes)}
          </div>
        ),
        confirmLabel: 'Elimina',
        danger: true,
      });
      if (!ok) return;
      await api.del(`/entries/${entry.id}`);
      toast('Turno eliminato');
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
      title={entry ? (entry.open ? 'Completa il turno' : 'Modifica turno') : 'Nuovo turno'}
      onClose={onClose}
      footer={
        <>
          {entry && (
            <button class="btn danger" style={{ flex: '0 0 auto' }} onClick={remove} disabled={busy} aria-label="Elimina">
              <Icon name="trash" />
            </button>
          )}
          <button class="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Salvo…' : 'Salva'}
          </button>
        </>
      }
    >
      <div class="stack">
        <div class="field">
          <label for="e-date">Data</label>
          <input id="e-date" class="input" type="date" value={d} onInput={(e) => setD(e.currentTarget.value)} />
        </div>
        <div class="fields-2">
          <div class="field">
            <label for="e-start">Inizio</label>
            <input id="e-start" class="input" type="time" step={60} value={start} onInput={(e) => setStart(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="e-end">Fine</label>
            <input id="e-end" class="input" type="time" step={60} value={end} onInput={(e) => setEnd(e.currentTarget.value)} />
          </div>
        </div>
        <div class="small muted">
          {calc ? (
            <>
              Durata: <b>{durLong(calc.minutes)}</b>
              {calc.nextDay && ' · la fine è il giorno dopo'}
            </>
          ) : (
            'Lascia vuota la fine se stai ancora lavorando: potrai completarla più tardi.'
          )}
        </div>
        <div class="field">
          <label for="e-note">Nota (facoltativa)</label>
          <input id="e-note" class="input" maxLength={200} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </div>
      </div>
    </Sheet>
  );
}

/** Scelta del tipo di giornata: lavoro (nessun tipo), ferie, malattia, … */
export function DayTypeChips({ date, type, onChanged }: { date: string; type: DayType | null; onChanged: () => void }) {
  async function pick(t: DayType | null) {
    if (t === type) return;
    try {
      await api.put('/daytype', { date, type: t });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <div class="chips" role="group" aria-label="Tipo di giornata">
      <button class={`chip ${type == null ? 'on' : ''}`} onClick={() => pick(null)}>
        Lavoro
      </button>
      {DAY_TYPES.map((t) => (
        <button key={t} class={`chip ${type === t ? 'on' : ''}`} onClick={() => pick(t)}>
          {DAY_TYPE_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

/** Dettaglio di un giorno: tipo, turni, aggiunta. */
export function DaySheet({ day, onClose, onChanged }: { day: Day; onClose: () => void; onChanged: () => void }) {
  const [edit, setEdit] = useState<Entry | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Sheet
        title={dayLong(day.date)}
        onClose={onClose}
        footer={
          <button class="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Aggiungi turno
          </button>
        }
      >
        <div class="stack">
          <div class="field">
            <div class="label">Tipo di giornata</div>
            <DayTypeChips date={day.date} type={day.type} onChanged={onChanged} />
            {!day.type && day.autoRest && <div class="small muted">Riposo proposto dalle tue impostazioni: scegli un tipo per confermarlo.</div>}
          </div>
          <div class="hr" />
          <div class="row between">
            <b>Turni</b>
            <span class="muted">
              Totale <b style={{ color: 'var(--ink)' }}>{dur(day.minutes)}</b>
            </span>
          </div>
          {day.entries.length === 0 ? (
            <div class="empty" style={{ padding: '10px 0' }}>
              Nessun turno registrato.
            </div>
          ) : (
            <div class="card flush">
              <div class="list">
                {day.entries.map((e) => (
                  <button key={e.id} class="list-item" onClick={() => setEdit(e)}>
                    <div class="grow">
                      <div class="shift-time">
                        {e.start} – {e.end ?? 'in corso'}
                        {e.nextDay && <span class="muted small"> (+1)</span>}
                      </div>
                      {e.note && <div class="small muted">{e.note}</div>}
                    </div>
                    <b>{e.open ? '…' : dur(e.minutes)}</b>
                    <Icon name="edit" size={18} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {day.warnings.map((w, i) => (
            <div key={i} class="banner">
              <Icon name="alert" />
              <div>{w.message}</div>
            </div>
          ))}
        </div>
      </Sheet>
      {adding && <EntrySheet date={day.date} onClose={() => setAdding(false)} onSaved={onChanged} />}
      {edit && <EntrySheet entry={edit} onClose={() => setEdit(null)} onSaved={onChanged} />}
    </>
  );
}
