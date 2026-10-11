'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { PageHead, Segmented, api, useLoad, useToast } from '@/components/ui';
import { useSite } from '@/components/site';
import { addDays, dedupePunches, localDate, zonedToUtc } from '@/lib/attendance';
import { ago, fmtDay, fmtTimeSec } from '@/lib/format';

const sb = supabaseBrowser();

interface Punch {
  id: number; employee_id: number | null; device_user_id: string; punched_at: string; verify_method: string | null;
  device_id: number; employees: { name: string } | null; devices: { name: string } | null;
}

export default function PunchLog() {
  const { timezone: tz } = useSite();
  const toast = useToast();
  const [dev, setDev] = useState<number | 'all'>('all');
  const [bindFor, setBindFor] = useState<Punch | null>(null);

  const { data, error, reload } = useLoad(async () => {
    const since = zonedToUtc(addDays(localDate(new Date(), tz), -1), '00:00', tz).toISOString();
    const [p, d, s, e] = await Promise.all([
      sb.from('raw_punches').select('id,employee_id,device_user_id,punched_at,verify_method,device_id,employees(name),devices(name)')
        .gte('punched_at', since).order('punched_at', { ascending: false }).limit(1000),
      sb.from('devices').select('id,name').order('name'),
      api<{ dedupe_window_sec: number }>('/api/settings'),
      sb.from('employees').select('id,name').eq('status', 'active').is('device_user_id', null).order('name'),
    ]);
    if (p.error) throw p.error;
    return { punches: (p.data ?? []) as unknown as Punch[], devices: d.data ?? [], window: s.dedupe_window_sec, unbound: e.data ?? [], at: Date.now() };
  }, [tz], 10_000);

  // The terminal sends no in/out flag, so label punches by order within each person's day.
  const labelled = useMemo(() => {
    const out = new Map<number, string>();
    if (!data) return out;
    const groups = new Map<string, Punch[]>();
    for (const p of data.punches) {
      const k = `${p.employee_id ?? 'u' + p.device_user_id}|${localDate(new Date(p.punched_at), tz)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
    for (const list of groups.values()) {
      const asc = [...list].sort((a, b) => a.punched_at.localeCompare(b.punched_at));
      const kept = new Set(dedupePunches(asc.map((p) => new Date(p.punched_at)), data.window).map((d) => d.getTime()));
      let n = 0;
      for (const p of asc) {
        if (!kept.has(new Date(p.punched_at).getTime())) out.set(p.id, 'Duplicate');
        else out.set(p.id, n++ % 2 === 0 ? 'In' : 'Out');
      }
    }
    return out;
  }, [data, tz]);

  const rows = (data?.punches ?? []).filter((p) => dev === 'all' || p.device_id === dev);
  const newest = data?.punches[0]?.punched_at ?? null;
  const cols = '110px minmax(180px,1.6fr) 90px minmax(150px,1fr) 110px 110px';

  return (
    <>
      <PageHead eyebrow={<span className="row" style={{ gap: 7 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: error ? 'var(--bad)' : 'var(--ok)' }} />{error ? 'Connection problem' : `Live · last punch ${ago(newest)} ago`}</span>} title="Punch log">
        <Segmented value={dev} onChange={setDev} options={[{ value: 'all', label: 'All devices' }, ...(data?.devices ?? []).map((d) => ({ value: d.id as number | 'all', label: d.name }))]} />
      </PageHead>
      {error && <div className="notice err">{error}</div>}
      <section className="card tbl">
        <div style={{ minWidth: 720 }}>
          <div className="tr th" style={{ gridTemplateColumns: cols }}><span>Time</span><span>Employee</span><span>Device ID</span><span>Device</span><span>Verified by</span><span>Punch type</span></div>
          {rows.map((p, i) => {
            const newDay = i === 0 || localDate(new Date(rows[i - 1].punched_at), tz) !== localDate(new Date(p.punched_at), tz);
            const dup = labelled.get(p.id) === 'Duplicate';
            return (
              <div key={p.id}>
                {newDay && <div style={{ padding: '8px 18px', fontSize: 12, fontWeight: 500, color: 'var(--muted)', background: '#FAFAF8' }}>{fmtDay(p.punched_at, tz)}</div>}
                <div className="tr" style={{ gridTemplateColumns: cols, opacity: dup ? 0.5 : 1, background: p.employee_id ? undefined : 'var(--warnbg)' }}>
                  <span className="mono" style={{ fontSize: 13.5 }}>{fmtTimeSec(p.punched_at, tz)}</span>
                  <span style={{ fontWeight: 500 }}>
                    {p.employees?.name ?? <>Unknown ID <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setBindFor(p)}>Assign to employee</button></>}
                  </span>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--soft)' }}>{p.device_user_id}</span>
                  <span style={{ color: 'var(--soft)' }}>{p.devices?.name}</span>
                  <span style={{ color: 'var(--soft)' }}>{p.verify_method ?? '–'}</span>
                  <span style={{ color: 'var(--soft)' }}>{labelled.get(p.id) ?? ''}</span>
                </div>
              </div>
            );
          })}
          {!rows.length && <div style={{ padding: '24px 18px' }} className="sub">{data ? 'No punches since yesterday.' : 'Loading…'}</div>}
        </div>
      </section>
      <div className="sub">Showing yesterday and today. Greyed rows are repeat scans within {data?.window ?? 120}s that reports ignore. In/Out is worked out from the order of scans, because the terminal does not record direction.</div>
      {bindFor && (
        <BindDialog punch={bindFor} unbound={data?.unbound ?? []} onClose={() => setBindFor(null)}
          onDone={(m) => { setBindFor(null); toast.show(m); reload(); }} />
      )}
      {toast.node}
    </>
  );
}

function BindDialog({ punch, unbound, onClose, onDone }: { punch: Punch; unbound: { id: number; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [emp, setEmp] = useState('');
  const [err, setErr] = useState('');
  async function bind() {
    const { error } = await sb.from('employees').update({ device_user_id: punch.device_user_id }).eq('id', Number(emp));
    if (error) return setErr(error.code === '23505' ? 'That ID is already assigned to someone else.' : error.message);
    const r = await api<{ bound_punches: number }>('/api/recompute', { method: 'POST', body: JSON.stringify({ employeeId: Number(emp) }) });
    onDone(`ID ${punch.device_user_id} assigned. ${r.bound_punches} earlier punch(es) now show the name.`);
  }
  return (
    <div className="drawer-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card pad" style={{ margin: 'auto', width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <strong>Who is ID <span className="mono">{punch.device_user_id}</span>?</strong>
        {unbound.length ? (
          <label className="field">Employee without a device ID
            <select value={emp} onChange={(e) => setEmp(e.target.value)}><option value="">Choose…</option>{unbound.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          </label>
        ) : <div className="sub">Every active employee already has an ID. Add the person on the Employees page, then assign this ID there.</div>}
        {err && <div className="notice err">{err}</div>}
        <div className="row"><button className="btn" disabled={!emp} onClick={bind}>Assign</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
