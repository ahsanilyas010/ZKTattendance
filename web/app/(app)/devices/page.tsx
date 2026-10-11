'use client';
import { Fragment, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Chip, PageHead, Segmented, api, useLoad, useToast } from '@/components/ui';
import { useSite } from '@/components/site';
import { agentState } from '@/lib/agentStatus';
import { ago } from '@/lib/format';

const sb = supabaseBrowser();

interface Device {
  id: number; name: string; ip: string; port: number; comm_password: number; location: string | null; model: string | null; serial: string | null;
  status: 'online' | 'offline' | 'unknown'; last_seen_at: string | null; last_punch_at: string | null; enrolled_count: number | null;
  clock_drift_sec: number | null; last_error: string | null;
}
interface Agent { id: number; name: string; poll_interval_sec: number; last_seen_at: string | null; version: string | null; hostname: string | null; queue_depth: number; last_error: string | null }
interface Shift { id: number; name: string; start_time: string; end_time: string; grace_minutes: number; absence_cutoff_minutes: number; work_days: number; crosses_midnight: boolean; is_default: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export default function DevicesSync() {
  const toast = useToast();
  const { data, reload } = useLoad(async () => {
    const [d, a, s, e] = await Promise.all([
      sb.from('devices').select('*').order('name'), sb.rpc('list_agents'),
      sb.from('shift_schedules').select('*').order('start_time'), sb.from('employees').select('shift_id').eq('status', 'active'),
    ]);
    return { devices: (d.data ?? []) as Device[], agents: (a.data ?? []) as Agent[], shifts: (s.data ?? []) as Shift[], emps: e.data ?? [] };
  }, [], 10_000);

  return (
    <>
      <PageHead eyebrow="Terminals, local sync agent, and shift rules" title="Devices & sync" />
      <DevicesSection devices={data?.devices ?? []} agentOnline={agentState(data?.agents[0]) === 'online'} reload={reload} toast={toast.show} />
      <AgentSection agents={data?.agents ?? []} reload={reload} toast={toast.show} />
      <ShiftSection shifts={data?.shifts ?? []} emps={data?.emps ?? []} reload={reload} toast={toast.show} />
      {toast.node}
    </>
  );
}

function DevicesSection({ devices, agentOnline, reload, toast }: { devices: Device[]; agentOnline: boolean; reload: () => void; toast: (m: string) => void }) {
  const site = useSite();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ color: 'var(--soft)' }}>Devices</strong>
        <button className="btn ghost small" onClick={() => setAdding(true)}>Add device</button>
      </div>
      {!agentOnline && devices.length > 0 && <div className="notice">The site agent is not connected, so device status below may be out of date.</div>}
      <section className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))' }}>
        {adding && <DeviceCard key="new" siteId={site.id} d={null} onDone={() => { setAdding(false); reload(); }} toast={toast} />}
        {devices.map((d) => <DeviceCard key={d.id} siteId={site.id} d={d} onDone={reload} toast={toast} />)}
      </section>
      {!devices.length && !adding && <div className="card pad sub">No terminals yet. Add one using its IP address from the device&apos;s network settings (default port 4370).</div>}
    </>
  );
}

function DeviceCard({ siteId, d, onDone, toast }: { siteId: number; d: Device | null; onDone: () => void; toast: (m: string) => void }) {
  const [f, setF] = useState({ name: d?.name ?? '', ip: d?.ip ?? '', port: String(d?.port ?? 4370), location: d?.location ?? '', pw: String(d?.comm_password ?? 0) });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const dirty = !d || f.name !== d.name || f.ip !== d.ip || f.port !== String(d.port) || f.location !== (d.location ?? '') || f.pw !== String(d.comm_password);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!f.name.trim()) return setErr('Give the device a name.');
    if (!IPV4.test(f.ip.trim())) return setErr('Enter the IP address as four numbers, like 192.168.1.201.');
    const port = Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setErr('Port must be between 1 and 65535 (usually 4370).');
    const row = { site_id: siteId, name: f.name.trim(), ip: f.ip.trim(), port, location: f.location.trim() || null, comm_password: Number(f.pw) || 0 };
    const { error } = d ? await sb.from('devices').update(row).eq('id', d.id) : await sb.from('devices').insert(row);
    if (error) return setErr(error.code === '23505' ? 'A device with that IP and port already exists.' : error.message);
    setErr(''); toast(d ? 'Device saved. The agent picks up changes on its next cycle.' : 'Device added.'); onDone();
  }

  /** Queue a command for the agent and wait for its answer. */
  async function command(kind: 'test_connection' | 'sync_users') {
    if (!d) return;
    setBusy(kind);
    const { data: c, error } = await sb.from('device_commands').insert({ device_id: d.id, kind }).select('id').single();
    if (error) { setBusy(''); return toast(error.message); }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: row } = await sb.from('device_commands').select('status,result').eq('id', c.id).single();
      if (row && row.status !== 'pending') { setBusy(''); toast(row.result ?? (row.status === 'done' ? 'Done.' : 'Failed.')); onDone(); return; }
    }
    setBusy('');
    toast('No answer from the site agent yet. Check that it is running on the site PC.');
  }

  const tone = !d ? 'idle' : d.status === 'online' ? 'present' : d.status === 'offline' ? 'absent' : 'idle';
  return (
    <div className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div><strong style={{ fontSize: 15 }}>{d?.name || 'New device'}</strong><div className="dim">{d?.model ?? 'Model detected on first connection'}{d?.serial ? <> · SN <span className="mono">{d.serial}</span></> : null}</div></div>
        {d && <Chip tone={tone}>{d.status === 'online' ? 'Online' : d.status === 'offline' ? 'Offline' : 'Unknown'}</Chip>}
      </div>
      <label className="field">Name<input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Front entrance" /></label>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
        <label className="field">IP address<input className="mono" value={f.ip} onChange={(e) => set('ip', e.target.value)} placeholder="192.168.1.201" /></label>
        <label className="field">Port<input className="mono" value={f.port} onChange={(e) => set('port', e.target.value)} /></label>
        <label className="field">Comm key<input className="mono" value={f.pw} onChange={(e) => set('pw', e.target.value)} title="Device communication password, 0 if none" /></label>
      </div>
      <label className="field">Location<input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Main entrance, ground floor" /></label>
      {err && <div className="notice err" role="alert">{err}</div>}
      {d?.last_error && d.status !== 'online' && <div className="dim" style={{ color: 'var(--bad-fg)' }}>Last error: {d.last_error}</div>}
      {d?.clock_drift_sec != null && Math.abs(d.clock_drift_sec) > 120 && <div className="notice" style={{ padding: '8px 12px' }}>The terminal clock is {Math.round(Math.abs(d.clock_drift_sec) / 60)} min {d.clock_drift_sec > 0 ? 'ahead of' : 'behind'} real time. Set its time on the device so punches are dated correctly.</div>}
      <div className="row" style={{ justifyContent: 'space-between', paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
        <span className="dim">{d ? `Seen ${ago(d.last_seen_at)} ago · ${d.enrolled_count ?? '?'} enrolled` : ''}</span>
        <span className="row" style={{ gap: 8 }}>
          {d && <button className="btn ghost small" disabled={!!busy} onClick={() => command('test_connection')}>{busy === 'test_connection' ? 'Testing…' : 'Test connection'}</button>}
          {d && <button className="btn ghost small" disabled={!!busy} onClick={() => command('sync_users')}>{busy === 'sync_users' ? 'Importing…' : 'Import people'}</button>}
          {dirty && <button className="btn small" onClick={save}>{d ? 'Save' : 'Add device'}</button>}
          {!d && <button className="btn ghost small" onClick={onDone}>Cancel</button>}
          {d && <button className="btn ghost small" onClick={async () => { if (confirm(`Remove ${d.name}? Its punch history is removed too.`)) { await sb.from('devices').delete().eq('id', d.id); onDone(); } }}>Remove</button>}
        </span>
      </div>
    </div>
  );
}

function AgentSection({ agents, reload, toast }: { agents: Agent[]; reload: () => void; toast: (m: string) => void }) {
  const [key, setKey] = useState<{ name: string; key: string } | null>(null);
  const [name, setName] = useState('');
  const url = typeof window === 'undefined' ? '' : window.location.origin;

  async function create() {
    if (!name.trim()) return toast('Name the agent first, e.g. OFFICE-PC.');
    try { const r = await api<{ api_key: string }>('/api/agents', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setKey({ name: name.trim(), key: r.api_key }); setName(''); reload(); }
    catch (e) { toast((e as Error).message); }
  }
  async function rotate(a: Agent) {
    if (!confirm(`Issue a new key for ${a.name}? The agent stops syncing until you update it on the site PC.`)) return;
    const r = await api<{ api_key: string }>(`/api/agents/${a.id}/rotate`, { method: 'POST' });
    setKey({ name: a.name, key: r.api_key });
  }
  const POLLS = [{ value: 10, label: '10 s' }, { value: 30, label: '30 s' }, { value: 60, label: '1 min' }, { value: 300, label: '5 min' }];

  return (
    <>
      <strong style={{ color: 'var(--soft)', marginTop: 8 }}>Local agent</strong>
      {key && (
        <div className="notice" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <strong>Agent key for {key.name}. Copy it now, it is shown only once.</strong>
          <pre className="mono" style={{ margin: 0, padding: 10, background: '#fff', borderRadius: 7, overflowX: 'auto', fontSize: 12.5, userSelect: 'all' }}>{`cloud_url = "${url}"\napi_key   = "${key.key}"`}</pre>
          <div className="row"><button className="btn ghost small" onClick={() => { navigator.clipboard.writeText(`cloud_url = "${url}"\napi_key   = "${key.key}"`); toast('Copied.'); }}>Copy</button><button className="btn ghost small" onClick={() => setKey(null)}>I have saved it</button></div>
        </div>
      )}
      {agents.map((a) => {
        const st = agentState(a);
        return (
          <section key={a.id} className="card pad grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="row" style={{ gap: 10 }}><strong style={{ fontSize: 15 }}>{a.name}</strong><Chip tone={st === 'online' ? 'present' : st === 'stale' ? 'absent' : 'idle'}>{st === 'online' ? 'Online' : st === 'stale' ? 'Offline' : 'Never connected'}</Chip></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 20px', fontSize: 13.5 }}>
                {[['Last sync', a.last_seen_at ? `${ago(a.last_seen_at)} ago` : 'never'], ['Host', a.hostname ?? '–'], ['Version', a.version ?? '–'], ['Waiting to upload', `${a.queue_depth} punches`], ['Last error', a.last_error ?? 'none']].map(([k, v]) => (
                  <Fragment key={k}><span style={{ color: 'var(--muted)' }}>{k}</span><span className="mono" style={{ fontSize: 13 }}>{v}</span></Fragment>
                ))}
              </div>
              <div><button className="btn ghost small" onClick={() => rotate(a)}>Regenerate key</button></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--soft)' }}>Polling interval</div>
              <Segmented value={a.poll_interval_sec} options={POLLS} onChange={async (v) => { await api(`/api/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ poll_interval_sec: v }) }); toast(`Polling every ${POLLS.find((p) => p.value === v)?.label}.`); reload(); }} />
              <div className="sub">How often the agent pulls new punches from each device. Shorter intervals make the Punch log closer to real time.</div>
            </div>
          </section>
        );
      })}
      <div className="card pad row">
        <input className="input" placeholder="Agent name, e.g. OFFICE-PC" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn ghost small" onClick={create}>{agents.length ? 'Add another site agent' : 'Create agent key'}</button>
        {!agents.length && <span className="sub">Create a key, then install the agent on the site PC (see AGENT-SETUP).</span>}
      </div>
    </>
  );
}

function ShiftSection({ shifts, emps, reload, toast }: { shifts: Shift[]; emps: { shift_id: number | null }[]; reload: () => void; toast: (m: string) => void }) {
  const site = useSite();
  const def = shifts.find((s) => s.is_default)?.id;
  async function add() {
    const { error } = await sb.from('shift_schedules').insert({ site_id: site.id, name: 'New shift', start_time: '09:00', end_time: '17:00', grace_minutes: 10, absence_cutoff_minutes: 30, work_days: 62, is_default: shifts.length === 0 });
    if (error) toast(error.message); else reload();
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <strong style={{ color: 'var(--soft)' }}>Shift schedules</strong>
        <button className="btn ghost small" onClick={add}>Add shift</button>
      </div>
      <section className="grid">
        {shifts.map((s) => <ShiftRow key={s.id + s.name + s.start_time} s={s} people={emps.filter((e) => (e.shift_id ?? def) === s.id).length} onSaved={() => { toast('Shift saved. Past days are being recalculated.'); reload(); }} toast={toast} />)}
      </section>
      <div className="sub">Arrivals after start + grace are flagged Late. With no punch by the absence cutoff after the start, the day counts as Absent. Employees without their own shift use the default one.</div>
    </>
  );
}

function ShiftRow({ s, people, onSaved, toast }: { s: Shift; people: number; onSaved: () => void; toast: (m: string) => void }) {
  const site = useSite();
  const [f, setF] = useState({ name: s.name, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), grace: s.grace_minutes, cutoff: s.absence_cutoff_minutes, days: s.work_days, def: s.is_default });
  const dirty = f.name !== s.name || f.start !== s.start_time.slice(0, 5) || f.end !== s.end_time.slice(0, 5) || f.grace !== s.grace_minutes || f.cutoff !== s.absence_cutoff_minutes || f.days !== s.work_days || f.def !== s.is_default;
  const overnight = f.end <= f.start;

  async function save() {
    if (!f.name.trim()) return toast('Name the shift.');
    if (f.days === 0) return toast('Pick at least one working day.');
    if (f.def && !s.is_default) await sb.from('shift_schedules').update({ is_default: false }).eq('site_id', site.id).neq('id', s.id);
    const { error } = await sb.from('shift_schedules').update({
      name: f.name.trim(), start_time: f.start, end_time: f.end, grace_minutes: f.grace, absence_cutoff_minutes: f.cutoff, work_days: f.days, crosses_midnight: overnight, is_default: f.def,
    }).eq('id', s.id);
    if (error) return toast(error.message);
    api('/api/recompute', { method: 'POST', body: JSON.stringify({ days: 60 }) }).catch(() => {});
    onSaved();
  }
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  return (
    <div className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>Shift<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Start<input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label className="field">End<input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
        <label className="field">Grace (min)<input type="number" min={0} style={{ width: 90 }} value={f.grace} onChange={(e) => setF({ ...f, grace: num(e.target.value) })} /></label>
        <label className="field">Absent after (min)<input type="number" min={0} style={{ width: 110 }} value={f.cutoff} onChange={(e) => setF({ ...f, cutoff: num(e.target.value) })} /></label>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="seg">{DAYS.map((d, i) => <button key={d} aria-pressed={(f.days & (1 << i)) !== 0} onClick={() => setF({ ...f, days: f.days ^ (1 << i) })}>{d}</button>)}</div>
        <span className="row" style={{ gap: 14 }}>
          {overnight && <span className="dim">Overnight shift</span>}
          <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="radio" checked={f.def} onChange={() => setF({ ...f, def: true })} disabled={s.is_default} />Default</label>
          <span className="dim">{people} {people === 1 ? 'person' : 'people'}</span>
          {dirty && <button className="btn small" onClick={save}>Save</button>}
          {!s.is_default && <button className="btn ghost small" onClick={async () => { if (confirm(`Delete ${s.name}? Its ${people} people fall back to the default shift.`)) { await sb.from('shift_schedules').delete().eq('id', s.id); onSaved(); } }}>Delete</button>}
        </span>
      </div>
    </div>
  );
}
