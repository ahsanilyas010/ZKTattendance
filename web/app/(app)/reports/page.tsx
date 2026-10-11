'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Chip, PageHead, Segmented, Switch, api, useLoad, useToast, type Tone } from '@/components/ui';
import { useSite } from '@/components/site';
import { RANGE_LABELS, defaultRange, nextRun, parseRecipients, resolveRange, type DateRangeKey } from '@/lib/ranges';
import { fmtDate, fmtTime, hoursLabel } from '@/lib/format';

const sb = supabaseBrowser();

interface Row {
  work_date: string; first_in: string | null; last_out: string | null; worked_minutes: number | null; is_late: boolean; late_minutes: number;
  is_early_leave: boolean; is_absent: boolean; is_leave: boolean; is_holiday: boolean; single_punch: boolean;
  employees: { id: number; name: string; department: string; device_user_id: string | null };
}
interface Template {
  id: number; name: string; kind: 'raw' | 'daily' | 'both'; date_range: DateRangeKey; department: string | null; late_absent_only: boolean;
  frequency: 'daily' | 'weekly' | 'monthly'; weekday: number | null; day_of_month: number | null; run_at: string;
  recipients: string[]; enabled: boolean; last_run_at: string | null; last_status: string | null;
}

const KINDS = [{ value: 'daily' as const, label: 'Daily summary' }, { value: 'raw' as const, label: 'Raw punch log' }, { value: 'both' as const, label: 'Both sheets' }];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function flag(r: Row): { label: string; tone: Tone } {
  if (r.is_absent) return { label: 'Absent', tone: 'absent' };
  if (r.is_leave) return { label: 'On leave', tone: 'idle' };
  if (r.is_holiday) return { label: 'Holiday', tone: 'idle' };
  if (r.is_late) return { label: `Late +${r.late_minutes} min`, tone: 'late' };
  if (r.is_early_leave) return { label: 'Left early', tone: 'late' };
  if (r.single_punch) return { label: 'Single punch', tone: 'idle' };
  return { label: 'On time', tone: 'present' };
}

export default function Reports() {
  const [tab, setTab] = useState<'now' | 'sched'>('now');
  return (
    <>
      <PageHead eyebrow="Daily summary derived from raw punches" title="Reports & export">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'now', label: 'Run now' }, { value: 'sched', label: 'Scheduled' }]} />
      </PageHead>
      {tab === 'now' ? <RunNow /> : <Scheduled />}
    </>
  );
}

function RunNow() {
  const { timezone: tz } = useSite();
  const init = resolveRange('last7', tz);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [emp, setEmp] = useState('all');
  const [dept, setDept] = useState('All departments');
  const [exc, setExc] = useState(false);
  const [kind, setKind] = useState<'daily' | 'raw' | 'both'>('daily');

  const { data: opts } = useLoad(async () => {
    const { data } = await sb.from('employees').select('id,name,department').order('name');
    return data ?? [];
  }, []);
  const depts = useMemo(() => ['All departments', ...Array.from(new Set((opts ?? []).map((e) => e.department))).sort()], [opts]);

  const { data: rows, error } = useLoad(async () => {
    const out: Row[] = [];
    for (let a = 0; a < 20000; a += 1000) {
      let q = sb.from('daily_attendance').select('work_date,first_in,last_out,worked_minutes,is_late,late_minutes,is_early_leave,is_absent,is_leave,is_holiday,single_punch,employees!inner(id,name,department,device_user_id)')
        .gte('work_date', from).lte('work_date', to);
      if (emp !== 'all') q = q.eq('employee_id', Number(emp));
      if (dept !== 'All departments') q = q.eq('employees.department', dept);
      if (exc) q = q.or('is_late.eq.true,is_absent.eq.true');
      const { data, error } = await q.order('work_date', { ascending: false }).order('id').range(a, a + 999);
      if (error) throw error;
      out.push(...(data as unknown as Row[]));
      if ((data?.length ?? 0) < 1000) break;
    }
    return out;
  }, [from, to, emp, dept, exc]);

  const list = rows ?? [];
  const tz2 = tz;
  const qs = new URLSearchParams({ from, to, kind, ...(emp !== 'all' ? { employeeId: emp } : {}), ...(dept !== 'All departments' ? { department: dept } : {}), ...(exc ? { lateAbsentOnly: '1' } : {}) });
  const minutes = list.reduce((s, r) => s + (r.worked_minutes ?? 0), 0);
  const preset = (k: DateRangeKey) => { const r = resolveRange(k, tz); setFrom(r.from); setTo(r.to); };

  return (
    <>
      <section className="card pad row" style={{ alignItems: 'flex-end', gap: 16 }}>
        <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="seg" style={{ height: 36 }}>
          {(['today', 'yesterday', 'last7', 'this_month', 'last_month'] as DateRangeKey[]).map((k) => <button key={k} onClick={() => preset(k)}>{RANGE_LABELS[k].replace(' so far', '')}</button>)}
        </div>
        <label className="field">Employee
          <select value={emp} onChange={(e) => setEmp(e.target.value)} style={{ minWidth: 180 }}><option value="all">All employees</option>{(opts ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        </label>
        <label className="field">Department
          <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ minWidth: 160 }}>{depts.map((d) => <option key={d}>{d}</option>)}</select>
        </label>
        <div className="row" style={{ height: 36, gap: 8 }}><Switch on={exc} onChange={setExc} label="Late and absent only" /><span>Late &amp; absent only</span></div>
      </section>
      {error && <div className="notice err">{error}</div>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 20, color: 'var(--soft)' }}>
          <span><strong style={{ color: 'var(--ink)' }}>{list.length}</strong> rows</span>
          <span><strong style={{ color: 'var(--ink)' }}>{list.filter((r) => r.is_late).length}</strong> late</span>
          <span><strong style={{ color: 'var(--ink)' }}>{list.filter((r) => r.is_absent).length}</strong> absent</span>
          <span><strong style={{ color: 'var(--ink)' }}>{hoursLabel(minutes)}</strong> worked</span>
        </div>
        <div className="row">
          <Segmented value={kind} onChange={setKind} options={KINDS} />
          <a className="btn" href={`/api/export?${qs}`} download>Export to Excel (.xlsx)</a>
        </div>
      </div>
      <section className="card tbl">
        <div style={{ minWidth: 820 }}>
          <div className="tr th" style={{ gridTemplateColumns: '110px minmax(190px,1.6fr) minmax(120px,1fr) 80px 80px 110px 150px' }}>
            <span>Date</span><span>Employee</span><span>Department</span><span>First in</span><span>Last out</span><span>Hours</span><span>Flag</span>
          </div>
          {list.slice(0, 30).map((r, i) => {
            const f = flag(r);
            return (
              <div key={i} className="tr" style={{ gridTemplateColumns: '110px minmax(190px,1.6fr) minmax(120px,1fr) 80px 80px 110px 150px' }}>
                <span style={{ color: 'var(--soft)' }}>{fmtDate(r.work_date)}</span>
                <span><strong style={{ fontWeight: 500 }}>{r.employees.name}</strong> <span className="mono dim" style={{ marginLeft: 6 }}>{r.employees.device_user_id}</span></span>
                <span style={{ color: 'var(--soft)' }}>{r.employees.department}</span>
                <span className="mono">{fmtTime(r.first_in, tz2)}</span><span className="mono">{fmtTime(r.last_out, tz2)}</span>
                <span className="mono">{hoursLabel(r.worked_minutes)}</span>
                <span><Chip tone={f.tone}>{f.label}</Chip></span>
              </div>
            );
          })}
          {!list.length && <div style={{ padding: '24px 18px' }} className="sub">{rows ? 'No attendance in this range.' : 'Loading…'}</div>}
          {list.length > 30 && <div style={{ padding: '12px 18px' }} className="sub">Preview shows the first 30 rows. The export includes all {list.length}.</div>}
        </div>
      </section>
    </>
  );
}

function Scheduled() {
  const site = useSite();
  const toast = useToast();
  const { data, reload } = useLoad(async () => {
    const [t, e] = await Promise.all([sb.from('export_templates').select('*').order('name'), sb.from('employees').select('department')]);
    return { templates: (t.data ?? []) as Template[], depts: Array.from(new Set((e.data ?? []).map((x) => x.department))).sort() };
  }, []);
  const blank = { name: '', frequency: 'weekly' as Template['frequency'], weekday: 1, day_of_month: 1, run_at: '07:00', date_range: 'last_week' as DateRangeKey, kind: 'both' as Template['kind'], department: '', to: '', exc: false };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function add() {
    const recipients = parseRecipients(f.to);
    if (!f.name.trim()) return setErr('Give the schedule a name.');
    if (!recipients.length) return setErr('Enter at least one valid email address.');
    const { error } = await sb.from('export_templates').insert({
      site_id: site.id, name: f.name.trim(), kind: f.kind, date_range: f.date_range, department: f.department || null, late_absent_only: f.exc,
      frequency: f.frequency, weekday: f.frequency === 'weekly' ? f.weekday : null, day_of_month: f.frequency === 'monthly' ? f.day_of_month : null,
      run_at: f.run_at, recipients,
    });
    if (error) return setErr(error.message);
    setErr(''); setF(blank); toast.show('Schedule saved.'); reload();
  }
  async function sendNow(t: Template) {
    toast.show(`Sending “${t.name}”…`);
    try { const r = await api<{ summary: string }>(`/api/export/run/${t.id}`, { method: 'POST' }); toast.show(`Sent to ${t.recipients.join(', ')} (${r.summary}).`); }
    catch (e) { toast.show((e as Error).message); }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', alignItems: 'start' }}>
      <section className="card">
        <div className="cardhead">Scheduled exports</div>
        {(data?.templates ?? []).map((t) => {
          const nx = t.enabled ? nextRun(t, site.timezone) : null;
          const when = t.frequency === 'daily' ? 'Every day' : t.frequency === 'weekly' ? `Every ${WEEKDAYS[t.weekday ?? 1]}` : `Day ${t.day_of_month} of each month`;
          return (
            <div key={t.id} className="listrow" style={{ padding: '14px 18px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <strong>{t.name}</strong>
                <span style={{ fontSize: 13, color: 'var(--soft)' }}>{when} at {t.run_at.slice(0, 5)} · {RANGE_LABELS[t.date_range]} · {t.department ?? 'All departments'}</span>
                <span className="dim" style={{ overflowWrap: 'anywhere' }}>To {t.recipients.join(', ')}</span>
                <span className="dim mono">{nx ? `Next run ${nx.toLocaleString('en-GB', { timeZone: site.timezone, dateStyle: 'medium', timeStyle: 'short' })}` : 'Paused'}</span>
                {t.last_status && <span className="dim">Last: {t.last_status}</span>}
                <span className="row" style={{ gap: 8, marginTop: 4 }}>
                  <button className="btn ghost small" onClick={() => sendNow(t)}>Send now</button>
                  <button className="btn ghost small" onClick={async () => { await sb.from('export_templates').delete().eq('id', t.id); reload(); }}>Delete</button>
                </span>
              </div>
              <Switch on={t.enabled} label={`Enable ${t.name}`} onChange={async (v) => { await sb.from('export_templates').update({ enabled: v }).eq('id', t.id); reload(); }} />
            </div>
          );
        })}
        {data && !data.templates.length && <div style={{ padding: 16 }} className="sub">No scheduled exports yet.</div>}
      </section>
      <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <strong>New scheduled export</strong>
        <label className="field">Name<input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Weekly summary" /></label>
        <div className="field">Frequency
          <Segmented value={f.frequency} onChange={(v) => setF((p) => ({ ...p, frequency: v, date_range: defaultRange(v) }))} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
        </div>
        <div className="row">
          {f.frequency === 'weekly' && <label className="field">Day<select value={f.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAYS[d]}</option>)}</select></label>}
          {f.frequency === 'monthly' && <label className="field">Day of month<input type="number" min={1} max={28} value={f.day_of_month} onChange={(e) => set('day_of_month', Math.min(28, Math.max(1, Number(e.target.value))))} style={{ width: 90 }} /></label>}
          <label className="field">Time<input type="time" value={f.run_at} onChange={(e) => set('run_at', e.target.value)} /></label>
          <label className="field">Department<select value={f.department} onChange={(e) => set('department', e.target.value)}><option value="">All departments</option>{(data?.depts ?? []).map((d) => <option key={d}>{d}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">Covers<select value={f.date_range} onChange={(e) => set('date_range', e.target.value as DateRangeKey)}>{(Object.keys(RANGE_LABELS) as DateRangeKey[]).map((k) => <option key={k} value={k}>{RANGE_LABELS[k]}</option>)}</select></label>
          <label className="field">Contents<select value={f.kind} onChange={(e) => set('kind', e.target.value as Template['kind'])}>{[...KINDS].map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
        </div>
        <div className="row" style={{ gap: 8 }}><Switch on={f.exc} onChange={(v) => set('exc', v)} label="Late and absent only" /><span>Late &amp; absent only</span></div>
        <label className="field">Email to<input value={f.to} onChange={(e) => set('to', e.target.value)} placeholder="name@company.com, …" /></label>
        {err && <div className="notice err">{err}</div>}
        <div><button className="btn" onClick={add}>Save schedule</button></div>
      </section>
      {toast.node}
    </div>
  );
}
