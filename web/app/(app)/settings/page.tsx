'use client';
import { useEffect, useState } from 'react';
import { isKeyMode, supabaseBrowser } from '@/lib/supabase/browser';
import { PageHead, api, useLoad, useToast } from '@/components/ui';
import { useSite } from '@/components/site';
import { fmtDate } from '@/lib/format';

const sb = supabaseBrowser();

interface SettingsDto {
  dedupe_window_sec: number; company_name: string; site: { name: string; timezone: string };
  smtp: { host: string; port: number; secure: boolean; user: string; from: string; has_password: boolean };
}
interface Holiday { id: number; holiday_date: string; name: string }

export default function Settings() {
  const toast = useToast();
  const [keyMode, setKeyMode] = useState(false);
  useEffect(() => setKeyMode(isKeyMode()), []);
  return (
    <>
      <PageHead eyebrow="Email, time zone and calendar" title="Settings" />
      <General toast={toast.show} />
      <Email toast={toast.show} />
      <Holidays toast={toast.show} />
      {!keyMode && <Password toast={toast.show} />}
      {toast.node}
    </>
  );
}

function useSettings() {
  return useLoad(() => api<SettingsDto>('/api/settings'), []);
}

async function put(dto: SettingsDto, pass: string | undefined, over: Partial<SettingsDto>, smtpOver: Partial<SettingsDto['smtp']> = {}) {
  const smtp = { ...dto.smtp, ...smtpOver };
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      dedupe_window_sec: over.dedupe_window_sec ?? dto.dedupe_window_sec, company_name: over.company_name ?? dto.company_name,
      site_name: over.site?.name ?? dto.site.name, timezone: over.site?.timezone ?? dto.site.timezone,
      smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from, ...(pass ? { pass } : {}) },
    }),
  });
}

function General({ toast }: { toast: (m: string) => void }) {
  const { data, reload } = useSettings();
  const [f, setF] = useState({ site: '', tz: '', company: '', dedupe: 120 });
  useEffect(() => { if (data) setF({ site: data.site.name, tz: data.site.timezone, company: data.company_name, dedupe: data.dedupe_window_sec }); }, [data]);
  if (!data) return <section className="card pad sub">Loading…</section>;
  async function save() {
    try {
      await put(data!, undefined, { company_name: f.company, dedupe_window_sec: f.dedupe, site: { name: f.site, timezone: f.tz } });
      api('/api/recompute', { method: 'POST', body: JSON.stringify({ days: 60 }) }).catch(() => {});
      toast('Saved. Reports are being recalculated with the new settings.'); reload();
    } catch (e) { toast((e as Error).message); }
  }
  return (
    <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <strong>General</strong>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Site name<input value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Company name (shown in emails)<input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Time zone<input list="tzs" value={f.tz} onChange={(e) => setF({ ...f, tz: e.target.value })} />
          <datalist id="tzs">{(Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone').map((z) => <option key={z} value={z} />)}</datalist>
          <span className="hint">All times in the dashboard and Excel files use this zone.</span></label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Ignore repeat scans within (seconds)
          <input type="number" min={0} value={f.dedupe} onChange={(e) => setF({ ...f, dedupe: Number(e.target.value) })} style={{ width: 120 }} />
          <span className="hint">Two scans closer than this count as one. Raw punches are never deleted.</span></label>
      </div>
      <div><button className="btn" onClick={save}>Save</button></div>
    </section>
  );
}

function Email({ toast }: { toast: (m: string) => void }) {
  const { data, reload } = useSettings();
  const [f, setF] = useState({ host: '', port: 587, secure: false, user: '', from: '', pass: '' });
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setF({ host: data.smtp.host, port: data.smtp.port, secure: data.smtp.secure, user: data.smtp.user, from: data.smtp.from, pass: '' }); }, [data]);
  if (!data) return null;

  async function save() {
    try { await put(data!, f.pass, {}, { host: f.host, port: f.port, secure: f.secure, user: f.user, from: f.from }); toast('Email settings saved.'); setF((p) => ({ ...p, pass: '' })); reload(); return true; }
    catch (e) { toast((e as Error).message); return false; }
  }
  async function test() {
    if (!to) return toast('Enter an address to send the test to.');
    setBusy(true);
    if (await save()) {
      try { await api('/api/settings/test-email', { method: 'POST', body: JSON.stringify({ to }) }); toast(`Test email sent to ${to}. Check the inbox.`); }
      catch (e) { toast(`Could not send: ${(e as Error).message}`); }
    }
    setBusy(false);
  }
  return (
    <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <strong>Email (SMTP)</strong>
      <div className="sub">Used for alerts and scheduled exports. For Gmail, use smtp.gmail.com, port 465 with SSL on, your address, and an app password.</div>
      <div className="row">
        <label className="field" style={{ flex: 2, minWidth: 200 }}>SMTP server<input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.example.com" /></label>
        <label className="field">Port<input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} style={{ width: 100 }} /></label>
        <label className="row" style={{ gap: 8, alignSelf: 'flex-end', height: 36 }}><input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} />SSL (port 465)</label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Username<input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} autoComplete="off" /></label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Password<input type="password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} placeholder={data.smtp.has_password ? '•••••••• (saved, leave blank to keep)' : ''} autoComplete="new-password" /></label>
      </div>
      <label className="field">Send from<input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="Attendance <attendance@yourcompany.com>" /></label>
      <div className="row">
        <button className="btn" onClick={save}>Save</button>
        <input className="input" type="email" placeholder="Send a test to…" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn ghost" disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send test email'}</button>
      </div>
    </section>
  );
}

function Holidays({ toast }: { toast: (m: string) => void }) {
  const site = useSite();
  const { data, reload } = useLoad(async () => ((await sb.from('holidays').select('*').order('holiday_date', { ascending: false }).limit(60)).data ?? []) as Holiday[], []);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const refresh = () => api('/api/recompute', { method: 'POST', body: JSON.stringify({ days: 400 }) }).catch(() => {});
  async function add() {
    if (!date || !name.trim()) return toast('Enter a date and a name.');
    const { error } = await sb.from('holidays').insert({ site_id: site.id, holiday_date: date, name: name.trim() });
    if (error) return toast(error.code === '23505' ? 'That date is already a holiday.' : error.message);
    setDate(''); setName(''); await refresh(); reload(); toast('Holiday added. No one is marked absent that day.');
  }
  return (
    <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <strong>Company holidays</strong>
      <div className="sub">Nobody is marked absent or late on these days, and no absence alerts are sent.</div>
      <div className="row">
        <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input" placeholder="Holiday name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn ghost small" onClick={add}>Add holiday</button>
      </div>
      {(data ?? []).map((h) => (
        <div key={h.id} className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
          <span><strong style={{ fontWeight: 500 }}>{h.name}</strong> <span className="dim">· {fmtDate(h.holiday_date)} {h.holiday_date.slice(0, 4)}</span></span>
          <button className="btn ghost small" onClick={async () => { await sb.from('holidays').delete().eq('id', h.id); await refresh(); reload(); }}>Remove</button>
        </div>
      ))}
    </section>
  );
}

function Password({ toast }: { toast: (m: string) => void }) {
  const [pw, setPw] = useState('');
  async function change() {
    if (pw.length < 10) return toast('Use at least 10 characters.');
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return toast(error.message);
    setPw(''); toast('Password changed.');
  }
  return (
    <section className="card pad row" style={{ alignItems: 'flex-end' }}>
      <label className="field" style={{ flex: 1, minWidth: 220 }}><strong style={{ fontSize: 14, color: 'var(--ink)' }}>Admin password</strong>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password (10+ characters)" autoComplete="new-password" /></label>
      <button className="btn ghost" onClick={change}>Change password</button>
    </section>
  );
}
