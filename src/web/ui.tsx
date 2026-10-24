import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from './api.ts';

// ---------- icone ----------

const ICONS: Record<string, JSX.Element> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  report: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  chart: <path d="M6 20v-9M12 20V4M18 20v-6" />,
  more: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M9 7V4h6v3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 8l9 6 9-6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.01" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  logout: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M16 8l4 4-4 4M20 12H9" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5S15.5 16.5 15.5 20" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.5 2.4 3.5 5.2" />
    </>
  ),
  play: <path d="M7 4l13 8-13 8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export function Icon({ name, size }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

// ---------- toast + conferma ----------

interface ToastItem {
  id: number;
  msg: string;
  kind: 'ok' | 'error';
}
interface ConfirmState {
  title: string;
  message: JSX.Element | string;
  confirmLabel: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

let toasts: ToastItem[] = [];
let confirmState: ConfirmState | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
let toastId = 0;

export function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  const id = ++toastId;
  toasts = [...toasts, { id, msg, kind }];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, kind === 'error' ? 5000 : 2600);
}

export function toastError(e: unknown) {
  toast(e instanceof ApiError || e instanceof Error ? e.message : 'Errore imprevisto.', 'error');
}

export function confirmDialog(opts: { title: string; message: JSX.Element | string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel ?? 'Conferma', danger: !!opts.danger, resolve };
    notify();
  });
}

export function Overlays() {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  const close = (v: boolean) => {
    const s = confirmState;
    confirmState = null;
    notify();
    s?.resolve(v);
  };
  return (
    <>
      {confirmState && (
        <Sheet
          title={confirmState.title}
          onClose={() => close(false)}
          z={70}
          footer={
            <>
              <button class="btn" onClick={() => close(false)}>
                Annulla
              </button>
              <button class={`btn ${confirmState.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
                {confirmState.confirmLabel}
              </button>
            </>
          }
        >
          <div>{confirmState.message}</div>
        </Sheet>
      )}
      <div class="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- sheet ----------

const openSheets: number[] = [];
let sheetSeq = 0;

export function Sheet({
  title,
  onClose,
  children,
  footer,
  z,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  z?: number;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const me = ++sheetSeq;
    openSheets.push(me);
    // con più sheet sovrapposti, Esc chiude solo quello in cima
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openSheets[openSheets.length - 1] === me && closeRef.current();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      openSheets.splice(openSheets.indexOf(me), 1);
      document.body.style.overflow = openSheets.length ? 'hidden' : prev;
    };
  }, []);
  return (
    <div class="backdrop" style={z ? { zIndex: z } : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-head">
          <h2>{title}</h2>
          <button class="icon-btn plain" onClick={onClose} aria-label="Chiudi">
            <Icon name="close" />
          </button>
        </div>
        <div class="sheet-body">{children}</div>
        {footer && <div class="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- caricamento dati ----------

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(
    async (silent = false) => {
      const n = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const d = await fn();
        if (n === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (n === seq.current) setError(e instanceof Error ? e.message : 'Errore');
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    run();
  }, [run]);
  return { data, error, loading, reload: () => run(true) };
}

export function MonthNav({ label, onPrev, onNext, onToday }: { label: string; onPrev: () => void; onNext: () => void; onToday?: () => void }) {
  return (
    <div class="month-nav">
      <button class="icon-btn" onClick={onPrev} aria-label="Precedente">
        <Icon name="left" />
      </button>
      <button class="title plain" style={{ border: 0, background: 'none', cursor: onToday ? 'pointer' : 'default' }} onClick={onToday} title="Vai a oggi">
        {label}
      </button>
      <button class="icon-btn" onClick={onNext} aria-label="Successivo">
        <Icon name="right" />
      </button>
    </div>
  );
}

export function Spinner({ text = 'Caricamento…' }: { text?: string }) {
  return <div class="spinner">{text}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="banner danger">
      <Icon name="alert" />
      <div>
        {message}
        {onRetry && (
          <div>
            <button class="btn small" onClick={onRetry}>
              Riprova
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
