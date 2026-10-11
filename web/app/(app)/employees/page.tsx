'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Chip, Drawer, PageHead, Segmented, api, useLoad, useToast } from '@/components/ui';
import { useSite } from '@/components/site';
import { initials } from '@/lib/format';

interface Emp {
  id: number; name: string; device_user_id: string | null; department: string; photo_path: string | null;
  status: 'active' | 'inactive'; join_date: string | null; shift_id: number | null; notes: string | null; enrollment_pending: boolean;
}
interface Shift { id: number; name: string; start_time: string; end_time: string }
interface Leave { id: number; start_date: string; end_date: string; note: string | null }

const sb = supabaseBrowser();

export default function Employees() {
  const site = useSite();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('All');
  const [act, setAct] = useState<'All' | 'active' | 'inactive'>('active');
  const [editing, setEditing] = useState<Emp | 'new' | null>(null);

  const { data, error, reload } = useLoad(async () => {
    const [e, s, d] = await Promise.all([
      sb.from('employees').select('*').order('name'),
      sb.from('shift_schedules').select('id,name,start_time,end_time').order('name'),
      sb.from('devices').select('id,name'),
    ]);
    if (e.error) throw e.error;
    const emps = (e.data ?? []) as Emp[];
    // Photos live in a private bucket: sign URLs in one batch.
    const paths = emps.map((x) => x.photo_path).filter(Boolean) as string[];
    const urls = new Map<string, string>();
    if (paths.length) {
      const { data: signed } = await sb.storage.from('employee-photos').createSignedUrls(paths, 3600);
      signed?.forEach((x) => x.path && x.signedUrl && urls.set(x.path, x.signedUrl));
    }
    return { emps, shifts: (s.data ?? []) as Shift[], urls, deviceCount: d.data?.length ?? 0 };
  }, []);

  const emps = data?.emps ?? [];
  const depts = useMemo(() => ['All', ...Array.from(new Set(emps.map((e) => e.department))).sort()], [emps]);
  const shiftName = (id: number | null) => { const s = data?.shifts.find((x) => x.id === id); return s ? `${s.name} ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}` : 'Default shift'; };
  const list = emps.filter((e) =>
    (dept === 'All' || e.department === dept) && (act === 'All' || e.status === act) &&
    (!q || e.name.toLowerCase().includes(q.toLowerCase()) || (e.device_user_id ?? '').includes(q.trim())));
  const unbound = emps.filter((e) => e.status === 'active' && !e.device_user_id);
  const active = emps.filter((e) => e.status === 'active').length;
  const cols = '52px minmax(200px,2fr) minmax(130px,1fr) minmax(220px,1.5fr) 120px';

  return (
    <>
      <PageHead eyebrow={`${active} active · ${emps.length - active} inactive`} title="Employees">
        <button className="btn" onClick={() => setEditing('new')}>Add employee</button>
      </PageHead>
      {error && <div className="notice err">{error}</div>}
      {unbound.map((u) => (
        <div key={u.id} className="notice">
          <div><strong>{u.name}</strong> has no device ID and can&apos;t clock in until enrolled on a device.</div>
          <button className="btn ghost small" onClick={() => setEditing(u)}>Assign device ID</button>
        </div>
      ))}
      <div className="row">
        <input className="input" style={{ width: 260, maxWidth: '100%' }} placeholder="Search name or device ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented value={dept} onChange={setDept} options={depts.map((d) => ({ value: d, label: d }))} />
        <Segmented value={act} onChange={setAct} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'All', label: 'All' }]} />
      </div>
      <section className="card tbl">
        <div style={{ minWidth: 760 }}>
          <div className="tr th" style={{ gridTemplateColumns: cols }}><span /><span>Name</span><span>Department</span><span>Device binding</span><span>Status</span></div>
          {list.map((e) => (
            <div key={e.id} className="tr" style={{ gridTemplateColumns: cols, opacity: e.status === 'inactive' ? 0.55 : 1, cursor: 'pointer' }} onClick={() => setEditing(e)}>
              <div className="avatar">{e.photo_path && data?.urls.get(e.photo_path) ? <img src={data.urls.get(e.photo_path)} alt="" /> : initials(e.name)}</div>
              <div><div style={{ fontSize: 15, fontWeight: 600 }}>{e.name}</div><div className="dim">{shiftName(e.shift_id)}</div></div>
              <span style={{ color: 'var(--soft)' }}>{e.department}</span>
              <div className="row" style={{ gap: 8 }}>
                {e.device_user_id ? <span className="idtag">ID {e.device_user_id}</span> : <Chip tone="late">Not enrolled</Chip>}
              </div>
              <span><Chip tone={e.status === 'active' ? 'present' : 'idle'}>{e.status === 'active' ? 'Active' : 'Inactive'}</Chip></span>
            </div>
          ))}
          {!list.length && !data && <div style={{ padding: '24px 18px' }} className="sub">Loading…</div>}
          {!list.length && data && <div style={{ padding: '24px 18px' }} className="sub">{emps.length ? 'No employees match.' : 'No employees yet. Add one, or import the people already on the terminal from Devices & sync.'}</div>}
        </div>
      </section>
      {editing && (
        <EmployeeDrawer
          emp={editing === 'new' ? null : editing} shifts={data?.shifts ?? []} depts={depts.filter((d) => d !== 'All')} siteId={site.id}
          photoUrl={editing !== 'new' && editing.photo_path ? data?.urls.get(editing.photo_path) : undefined}
          onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); toast.show(m); reload(); }}
        />
      )}
      {toast.node}
    </>
  );
}

function EmployeeDrawer({ emp, shifts, depts, siteId, photoUrl, onClose, onSaved }: {
  emp: Emp | null; shifts: Shift[]; depts: string[]; siteId: number; photoUrl?: string;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [f, setF] = useState({
    name: emp?.name ?? '', device_user_id: emp?.device_user_id ?? '', department: emp?.department ?? (depts[0] ?? 'General'),
    shift_id: emp?.shift_id ? String(emp.shift_id) : '', join_date: emp?.join_date ?? '', status: emp?.status ?? 'active',
    notes: emp?.notes ?? '', push: false,
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setErr('');
    if (!f.name.trim()) return setErr('Name is required.');
    if (photo && photo.size > 3_000_000) return setErr('Photo must be under 3 MB.');
    setBusy(true);
    try {
      const idChanged = (f.device_user_id.trim() || null) !== (emp?.device_user_id ?? null);
      const row = {
        site_id: siteId, name: f.name.trim(), device_user_id: f.device_user_id.trim() || null, department: f.department.trim() || 'General',
        shift_id: f.shift_id ? Number(f.shift_id) : null, join_date: f.join_date || null, status: f.status, notes: f.notes.trim() || null,
        ...(f.push && f.device_user_id.trim() ? { enrollment_pending: true } : {}),
      };
      const res = emp ? await sb.from('employees').update(row).eq('id', emp.id).select('id').single()
                      : await sb.from('employees').insert(row).select('id').single();
      if (res.error) {
        if (res.error.code === '23505') {
          const { data: other } = await sb.from('employees').select('name').eq('device_user_id', row.device_user_id!).maybeSingle();
          throw new Error(`Device ID ${row.device_user_id} is already assigned to ${other?.name ?? 'another employee'}.`);
        }
        throw new Error(res.error.message);
      }
      const id = res.data.id as number;
      if (photo) {
        const path = `${siteId}/${id}-${Date.now()}.${photo.name.split('.').pop()?.toLowerCase() ?? 'jpg'}`;
        const up = await sb.storage.from('employee-photos').upload(path, photo, { contentType: photo.type });
        if (up.error) throw new Error(`Photo upload failed: ${up.error.message}`);
        await sb.from('employees').update({ photo_path: path }).eq('id', id);
        if (emp?.photo_path) await sb.storage.from('employee-photos').remove([emp.photo_path]);
      }
      // Binding an ID attaches earlier unknown punches; shift/status/join date changes re-derive history.
      if (idChanged || emp) await api('/api/recompute', { method: 'POST', body: JSON.stringify({ employeeId: id }) }).catch(() => {});
      onSaved(emp ? `Saved ${f.name}.` : `Added ${f.name}.`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Drawer title={emp ? 'Edit employee' : 'Add employee'} onClose={onClose}>
      <div className="row">
        <div className="avatar" style={{ width: 64, height: 64 }}>{photo ? <img src={URL.createObjectURL(photo)} alt="" /> : photoUrl ? <img src={photoUrl} alt="" /> : initials(f.name || '?')}</div>
        <label className="field">Photo<input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></label>
      </div>
      <label className="field">Full name<input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus /></label>
      <label className="field">Device ID number
        <input className="mono" value={f.device_user_id} onChange={(e) => set('device_user_id', e.target.value)} placeholder="The ID this person uses on the terminal" />
        <span className="hint">Must match the terminal exactly (e.g. 0042). Leave empty if not enrolled yet.</span>
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>Department
          <input list="depts" value={f.department} onChange={(e) => set('department', e.target.value)} />
          <datalist id="depts">{depts.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        <label className="field" style={{ flex: 1 }}>Shift
          <select value={f.shift_id} onChange={(e) => set('shift_id', e.target.value)}>
            <option value="">Default shift</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>Join date<input type="date" value={f.join_date} onChange={(e) => set('join_date', e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Status
          <select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </label>
      </div>
      <label className="field">Notes<textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={f.push} onChange={(e) => set('push', e.target.checked)} />
        Also write this name and ID to the terminal (they still need to enrol their face or finger there)
      </label>
      {emp && <LeaveSection employeeId={emp.id} />}
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row"><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Drawer>
  );
}

function LeaveSection({ employeeId }: { employeeId: number }) {
  const { data, reload } = useLoad(async () => {
    const { data } = await sb.from('leave_entries').select('*').eq('employee_id', employeeId).order('start_date', { ascending: false }).limit(20);
    return (data ?? []) as Leave[];
  }, [employeeId]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const refresh = () => api('/api/recompute', { method: 'POST', body: JSON.stringify({ employeeId }) }).catch(() => {});
  async function add() {
    if (!from || !to) return setMsg('Choose from and to dates.');
    if (to < from) return setMsg('"To" must not be before "From".');
    const { error } = await sb.from('leave_entries').insert({ employee_id: employeeId, start_date: from, end_date: to, note: note || null });
    if (error) return setMsg(error.message);
    setMsg(''); setFrom(''); setTo(''); setNote(''); await refresh(); reload();
  }
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <strong style={{ fontSize: 13 }}>Leave</strong>
      {(data ?? []).map((l) => (
        <div key={l.id} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
          <span>{l.start_date} → {l.end_date}{l.note ? ` · ${l.note}` : ''}</span>
          <button className="btn ghost small" onClick={async () => { await sb.from('leave_entries').delete().eq('id', l.id); await refresh(); reload(); }}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Leave from" />
        <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Leave to" />
        <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button className="btn ghost small" onClick={add}>Add leave</button>
      </div>
      {msg && <div className="dim" style={{ color: 'var(--bad-fg)' }}>{msg}</div>}
    </div>
  );
}
