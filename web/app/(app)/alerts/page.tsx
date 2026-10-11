'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Chip, PageHead, Switch, api, useLoad, useToast, type Tone } from '@/components/ui';
import { useSite } from '@/components/site';
import { parseRecipients } from '@/lib/ranges';
import { ago } from '@/lib/format';

const sb = supabaseBrowser();
type Trigger = 'late' | 'absent' | 'device_offline' | 'agent_offline' | 'daily_summary';
interface Rule {
  id: number; name: string; trigger_type: Trigger; threshold_minutes: number; send_at: string | null; department: string | null;
  employee_id: number | null; recipients: string[]; subject_template: string; body_template: string; enabled: boolean;
  last_sent_at: string | null; last_sent_summary: string | null;
}

const TRIGGERS: Record<Trigger, { label: string; tone: Tone; cond?: string; unit?: string; def: number }> = {
  late: { label: 'Late arrival', tone: 'late', cond: 'Alert when an employee is late by at least', unit: 'minutes', def: 15 },
  absent: { label: 'Absence', tone: 'absent', cond: 'Alert when there is still no punch', unit: 'minutes after shift start', def: 30 },
  device_offline: { label: 'Device offline', tone: 'idle', cond: 'Alert when a terminal has been unreachable for', unit: 'minutes', def: 10 },
  agent_offline: { label: 'Site agent offline', tone: 'idle', cond: 'Alert when the site PC has not checked in for', unit: 'minutes', def: 15 },
  daily_summary: { label: 'Daily summary', tone: 'present', def: 0 },
};

const blank = () => ({ id: 0, name: '', trigger_type: 'late' as Trigger, threshold_minutes: 15, send_at: '18:00', department: '', employee_id: '', recipients: '', subject_template: '', body_template: '', enabled: true });
type Draft = ReturnType<typeof blank>;

const describe = (r: Rule) => {
  const t = TRIGGERS[r.trigger_type];
  return r.trigger_type === 'daily_summary' ? `Every day at ${(r.send_at ?? '18:00').slice(0, 5)}` : `${t.cond?.replace('Alert when ', '').replace(/^an? /, '')} ${r.threshold_minutes} ${t.unit}`;
};

export default function Alerts() {
  const site = useSite();
  const toast = useToast();
  const [d, setD] = useState<Draft>(blank());
  const [err, setErr] = useState('');
  const [showMsg, setShowMsg] = useState(false);

  const { data, reload } = useLoad(async () => {
    const [r, e] = await Promise.all([sb.from('alert_rules').select('*').order('id'), sb.from('employees').select('id,name,department').eq('status', 'active').order('name')]);
    return { rules: (r.data ?? []) as Rule[], emps: e.data ?? [] };
  }, []);
  const depts = Array.from(new Set((data?.emps ?? []).map((e) => e.department))).sort();
  const t = TRIGGERS[d.trigger_type];

  const edit = (r: Rule) => { setErr(''); setShowMsg(!!(r.subject_template || r.body_template)); setD({ ...r, send_at: (r.send_at ?? '18:00').slice(0, 5), department: r.department ?? '', employee_id: r.employee_id ? String(r.employee_id) : '', recipients: r.recipients.join(', ') }); };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function save() {
    const recipients = parseRecipients(d.recipients);
    if (!d.name.trim()) return setErr('Give the rule a name.');
    if (!recipients.length) return setErr('Enter at least one valid email address.');
    if (d.trigger_type !== 'daily_summary' && !(d.threshold_minutes >= 0)) return setErr('Enter a number of minutes.');
    const row = {
      site_id: site.id, name: d.name.trim(), trigger_type: d.trigger_type, threshold_minutes: d.threshold_minutes,
      send_at: d.trigger_type === 'daily_summary' ? d.send_at : null, department: d.department || null,
      employee_id: d.employee_id ? Number(d.employee_id) : null, recipients, subject_template: d.subject_template, body_template: d.body_template, enabled: d.enabled,
    };
    const { error } = d.id ? await sb.from('alert_rules').update(row).eq('id', d.id) : await sb.from('alert_rules').insert(row);
    if (error) return setErr(error.message);
    setErr(''); toast.show(d.id ? 'Rule saved.' : 'Rule created.'); setD(blank()); reload();
  }
  async function test() {
    if (!d.id) return setErr('Save the rule first, then send a test.');
    try { await api(`/api/alerts/${d.id}/test`, { method: 'POST' }); toast.show(`Test email sent to ${d.recipients}.`); }
    catch (e) { setErr((e as Error).message); }
  }

  const rules = data?.rules ?? [];
  return (
    <>
      <PageHead eyebrow={`${rules.filter((r) => r.enabled).length} of ${rules.length} rules on`} title="Alerts">
        <button className="btn ghost" onClick={() => { setD(blank()); setErr(''); setShowMsg(false); }}>New rule</button>
      </PageHead>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(300px,1fr)', alignItems: 'start' }}>
        <section className="card">
          {rules.map((r) => (
            <div key={r.id} className="listrow" style={{ padding: '14px 18px', cursor: 'pointer', background: d.id === r.id ? '#FAFAF8' : undefined, boxShadow: d.id === r.id ? 'inset 3px 0 0 var(--ink)' : undefined }} onClick={() => edit(r)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, opacity: r.enabled ? 1 : 0.55 }}>
                <div className="row" style={{ gap: 10 }}><strong>{r.name}</strong><Chip tone={TRIGGERS[r.trigger_type].tone}>{TRIGGERS[r.trigger_type].label}</Chip></div>
                <span style={{ fontSize: 13, color: 'var(--soft)' }}>{describe(r)} · {r.employee_id ? data?.emps.find((e) => e.id === r.employee_id)?.name : r.department ?? 'All departments'}</span>
                <span className="dim" style={{ overflowWrap: 'anywhere' }}>Email → {r.recipients.join(', ')}</span>
                <span className="dim">Last sent: {r.last_sent_at ? `${ago(r.last_sent_at)} ago · ${r.last_sent_summary ?? ''}` : r.last_sent_summary ?? 'Never'}</span>
              </div>
              <Switch on={r.enabled} label={`Enable ${r.name}`} onChange={async (v) => { await sb.from('alert_rules').update({ enabled: v }).eq('id', r.id); reload(); }} />
            </div>
          ))}
          {data && !rules.length && <div style={{ padding: 16 }} className="sub">No rules yet. Create one on the right, for example “Late by 15 minutes”.</div>}
        </section>
        <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 20 }}>
          <strong>{d.id ? 'Edit rule' : 'New rule'}</strong>
          <label className="field">Rule name<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field">Trigger
            <select value={d.trigger_type} onChange={(e) => { const v = e.target.value as Trigger; setD((p) => ({ ...p, trigger_type: v, threshold_minutes: TRIGGERS[v].def })); }}>
              {(Object.keys(TRIGGERS) as Trigger[]).map((k) => <option key={k} value={k}>{TRIGGERS[k].label}</option>)}
            </select>
          </label>
          {t.cond && <label className="field">{t.cond}
            <span className="row" style={{ gap: 8 }}><input type="number" min={0} value={d.threshold_minutes} onChange={(e) => set('threshold_minutes', Number(e.target.value))} style={{ width: 90, height: 36, padding: '0 10px', border: '1px solid var(--field)', borderRadius: 7 }} /><span style={{ fontWeight: 400 }}>{t.unit}</span></span>
          </label>}
          {d.trigger_type === 'daily_summary' && <label className="field">Send every day at<input type="time" value={d.send_at} onChange={(e) => set('send_at', e.target.value)} style={{ width: 140 }} /></label>}
          {(d.trigger_type === 'late' || d.trigger_type === 'absent' || d.trigger_type === 'daily_summary') && (
            <div className="row">
              <label className="field" style={{ flex: 1, minWidth: 130 }}>Department<select value={d.department} onChange={(e) => set('department', e.target.value)}><option value="">All departments</option>{depts.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="field" style={{ flex: 1, minWidth: 130 }}>Employee<select value={d.employee_id} onChange={(e) => set('employee_id', e.target.value)}><option value="">Everyone in scope</option>{(data?.emps ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            </div>
          )}
          <label className="field">Send via<select disabled><option>Email</option></select></label>
          <label className="field">Recipients<textarea rows={2} value={d.recipients} onChange={(e) => set('recipients', e.target.value)} /><span className="hint">Comma-separated email addresses</span></label>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowMsg(!showMsg)}>{showMsg ? 'Hide message wording' : 'Customize message wording'}</button>
          {showMsg && <>
            <label className="field">Subject<input value={d.subject_template} onChange={(e) => set('subject_template', e.target.value)} placeholder="Leave empty for the default" /></label>
            <label className="field">Body<textarea rows={4} value={d.body_template} onChange={(e) => set('body_template', e.target.value)} placeholder="Leave empty for the default" />
              <span className="hint">You can use {'{{names}} {{list}} {{count}} {{date}} {{minutes}}'}</span></label>
          </>}
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row">
            <button className="btn" onClick={save}>Save rule</button>
            <button className="btn ghost" onClick={test}>Send test email</button>
            {d.id > 0 && <button className="btn ghost" onClick={async () => { await sb.from('alert_rules').delete().eq('id', d.id); setD(blank()); reload(); }}>Delete</button>}
          </div>
        </section>
      </div>
      {toast.node}
    </>
  );
}
