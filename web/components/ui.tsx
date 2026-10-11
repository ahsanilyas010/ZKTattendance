'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Tone = 'present' | 'late' | 'absent' | 'idle';
const TONES: Record<Tone, { fg: string; bg: string; dot: string }> = {
  present: { fg: 'var(--ok-fg)', bg: 'var(--ok-bg)', dot: 'var(--ok)' },
  late: { fg: 'var(--late-fg)', bg: 'var(--late-bg)', dot: 'var(--late)' },
  absent: { fg: 'var(--bad-fg)', bg: 'var(--bad-bg)', dot: 'var(--bad)' },
  idle: { fg: 'var(--idle-fg)', bg: 'var(--idle-bg)', dot: 'var(--idle)' },
};

export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <span className="chip" style={{ background: t.bg, color: t.fg }}>
      <i style={{ background: t.dot }} />
      {children}
    </span>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch"
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}><span /></button>
  );
}

export function useToast() {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(''), 4500);
  }, []);
  return { show, node: msg ? <div className="toast" role="status">{msg}</div> : null };
}

/** Load data on mount and whenever deps change; optionally poll. Errors surface as `error`. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    const run = () => fnRef.current().then((d) => { if (live) { setData(d); setError(null); } }, (e) => { if (live) setError(String(e?.message ?? e)); });
    run();
    const id = pollMs ? setInterval(run, pollMs) : undefined;
    return () => { live = false; if (id) clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, pollMs]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drawer-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function PageHead({ eyebrow, title, children }: { eyebrow?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="head">
      <div><div className="sub">{eyebrow}</div><h1>{title}</h1></div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}
