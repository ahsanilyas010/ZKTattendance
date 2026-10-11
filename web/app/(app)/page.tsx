import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { Chip, type Tone } from '@/components/ui';
import { AutoRefresh } from '@/components/nav';
import { addDays, dayOfWeek, localDate, zonedToUtc } from '@/lib/attendance';
import { agentState } from '@/lib/agentStatus';
import { listAgents } from '@/lib/agents';
import { ago, fmtDate, fmtTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Status = 'present' | 'late' | 'absent' | 'leave' | 'left' | 'pending';
const SEGS: { key: Status; label: string; color: string }[] = [
  { key: 'present', label: 'Present', color: 'var(--ok)' },
  { key: 'late', label: 'Late', color: 'var(--late)' },
  { key: 'pending', label: 'Not in yet', color: '#C9C8C2' },
  { key: 'absent', label: 'Absent', color: 'var(--bad)' },
  { key: 'leave', label: 'On leave', color: 'var(--idle)' },
  { key: 'left', label: 'Clocked out', color: '#B9BABD' },
];

export default async function Today() {
  const sb = await supabaseServer();
  const { data: site } = await sb.from('sites').select('timezone').order('id').limit(1).single();
  const tz = site?.timezone ?? 'UTC';
  const now = new Date();
  const today = localDate(now, tz);

  const [{ data: emps }, { data: shifts }, { data: att }, { data: holiday }, { data: devices }, agents] = await Promise.all([
    sb.from('employees').select('id,name,department,device_user_id,shift_id,join_date').eq('status', 'active').order('name'),
    sb.from('shift_schedules').select('*'),
    sb.from('daily_attendance').select('*').eq('work_date', today),
    sb.from('holidays').select('name').eq('holiday_date', today).maybeSingle(),
    sb.from('devices').select('id,name,status,last_seen_at,last_punch_at,location').eq('enabled', true).order('name'),
    listAgents(),
  ]);

  const shiftById = new Map((shifts ?? []).map((s) => [s.id as number, s]));
  const defShift = (shifts ?? []).find((s) => s.is_default) ?? (shifts ?? [])[0];
  const attBy = new Map((att ?? []).map((a) => [a.employee_id as number, a]));

  const rows = (emps ?? []).flatMap((e) => {
    const shift = (e.shift_id && shiftById.get(e.shift_id)) || defShift;
    const a = attBy.get(e.id);
    const workDay = !!shift && (shift.work_days & (1 << dayOfWeek(today))) !== 0;
    const joined = !e.join_date || e.join_date <= today;
    if (holiday || !joined || (!workDay && !a?.punch_count)) return [];
    const endUtc = shift ? zonedToUtc(shift.crosses_midnight ? addDays(today, 1) : today, shift.end_time, tz) : now;
    let status: Status = 'pending';
    if (a?.is_leave) status = 'leave';
    else if (a?.is_absent) status = 'absent';
    else if (a?.punch_count) status = a.last_out && now >= endUtc ? 'left' : a.is_late ? 'late' : 'present';
    return [{ e, a, status, shift }];
  });

  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const accounted = rows.filter((r) => ['present', 'late', 'leave', 'left'].includes(r.status)).length;
  const inBuilding = rows.filter((r) => (r.status === 'present' || r.status === 'late') && !r.a?.last_out).length;
  const absent = rows.filter((r) => r.status === 'absent');
  const late = rows.filter((r) => r.status === 'late');
  const present = rows.filter((r) => r.status === 'present' || r.status === 'left');
  const pending = rows.filter((r) => r.status === 'pending');
  const offline = (devices ?? []).filter((d) => d.status === 'offline');
  const agent = agents[0];
  const st = agentState(agent);
  const tone = (s: string): Tone => (s === 'online' ? 'present' : s === 'offline' ? 'absent' : 'idle');

  return (
    <>
      <AutoRefresh everyMs={30_000} />
      <div className="head">
        <div><div className="sub">{fmtDate(today)}{holiday ? ` · Holiday: ${holiday.name}` : ''}</div><h1>Today</h1></div>
        <div className="row">
          <span className="sub mono">Updated {fmtTime(now.toISOString(), tz)}</span>
          <a className="btn" href={`/api/export?from=${today}&to=${today}&kind=both`}>Export today&apos;s log (.xlsx)</a>
        </div>
      </div>

      <section className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
        <div style={{ padding: '24px 28px', borderRight: '1px solid #EFEEEA', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="sub" style={{ fontWeight: 500 }}>Accounted for</div>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className="big">{accounted}</span><span style={{ fontSize: 28, color: 'var(--muted)', fontWeight: 500 }}>/ {rows.length}</span>
          </div>
          {absent.length === 0 && pending.length === 0 && rows.length > 0 && <div style={{ color: 'var(--ok-fg)', fontWeight: 500, fontSize: 15 }}>Everyone is accounted for</div>}
          {absent.length > 0 && <div style={{ color: 'var(--bad-fg)', fontWeight: 500, fontSize: 15 }}>{absent.map((r) => r.e.name).join(', ')} {absent.length === 1 ? 'is' : 'are'} absent</div>}
          {offline.length > 0 && <div className="notice" style={{ marginTop: 4, padding: '8px 10px' }}>{offline.map((d) => d.name).join(', ')} {offline.length === 1 ? 'is' : 'are'} offline. Counts may be incomplete until {offline.length === 1 ? 'it' : 'they'} reconnect{offline.length === 1 ? 's' : ''}.</div>}
          {st !== 'online' && <div className="notice" style={{ marginTop: 4, padding: '8px 10px' }}>{st === 'never' ? 'No site agent has connected yet.' : `The site agent last synced ${ago(agent!.last_seen_at)} ago. Recent punches may be missing.`}</div>}
        </div>
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, justifyContent: 'center' }}>
          <div style={{ display: 'flex', gap: 3, height: 14, borderRadius: 5, overflow: 'hidden' }}>
            {SEGS.map((s) => count(s.key) > 0 && <div key={s.key} style={{ flex: count(s.key), background: s.color }} />)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: 16 }}>
            {SEGS.map((s) => (
              <div key={s.key}>
                <div className="row" style={{ gap: 6, fontSize: 13, color: 'var(--soft)' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{count(s.key)}</div>
              </div>
            ))}
          </div>
          <div className="sub">Accounted for = present, late, on leave, or already clocked out. {inBuilding} {inBuilding === 1 ? 'person is' : 'people are'} in the building now.</div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12 }}>
        {(devices ?? []).map((d) => (
          <div key={d.id} className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><strong>{d.name}</strong><Chip tone={tone(d.status)}>{d.status === 'unknown' ? 'Unknown' : d.status === 'online' ? 'Online' : 'Offline'}</Chip></div>
            <div className="sub">{d.location ? `${d.location} · ` : ''}last punch {d.last_punch_at ? `${ago(d.last_punch_at)} ago` : 'none yet'}</div>
          </div>
        ))}
        <Link href="/devices" className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, textDecoration: 'none' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>Local agent</strong><Chip tone={st === 'online' ? 'present' : st === 'stale' ? 'absent' : 'idle'}>{st === 'online' ? 'Online' : st === 'stale' ? 'Offline' : 'Not connected'}</Chip></div>
          <div className="sub">Last sync {agent?.last_seen_at ? `${ago(agent.last_seen_at)} ago` : 'never'}</div>
        </Link>
      </section>

      <section className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', alignItems: 'start' }}>
        <div className="card">
          <div className="cardhead"><span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--bad)' }} />Absent<span className="count">{absent.length}</span></div>
          {absent.map(({ e, shift }) => (
            <div key={e.id} className="listrow">
              <div><div className="n">{e.name}</div><div className="dim">{e.department} · <span className="mono">ID {e.device_user_id ?? '–'}</span></div></div>
              <div style={{ textAlign: 'right' }}><div style={{ color: 'var(--bad-fg)', fontWeight: 500, fontSize: 13 }}>No punch</div><div className="dim mono">due {shift ? String(shift.start_time).slice(0, 5) : ''}</div></div>
            </div>
          ))}
          {absent.length === 0 && <div style={{ padding: 16 }} className="sub">No one absent.</div>}
          {pending.length > 0 && <>
            <div style={{ padding: '10px 16px 4px', fontSize: 12, fontWeight: 500, color: 'var(--muted)', background: '#FAFAF8' }}>Not in yet (before cutoff)</div>
            {pending.map(({ e }) => <div key={e.id} className="listrow" style={{ background: '#FAFAF8', padding: '9px 16px' }}><span>{e.name}</span><span className="dim">{e.department}</span></div>)}
          </>}
        </div>
        <div className="card">
          <div className="cardhead"><span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--late)' }} />Late<span className="count">{late.length}</span></div>
          {late.map(({ e, a }) => (
            <div key={e.id} className="listrow">
              <div><div className="n">{e.name}</div><div className="dim">{e.department} · <span className="mono">ID {e.device_user_id ?? '–'}</span></div></div>
              <div style={{ textAlign: 'right' }}><div className="mono" style={{ fontSize: 13 }}>{fmtTime(a?.first_in ?? null, tz)}</div><div style={{ color: 'var(--late-fg)', fontWeight: 500, fontSize: 12.5 }}>+{a?.late_minutes} min</div></div>
            </div>
          ))}
          {late.length === 0 && <div style={{ padding: 16 }} className="sub">No late arrivals.</div>}
        </div>
        <div className="card">
          <div className="cardhead"><span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--ok)' }} />Present on time<span className="count">{present.length}</span></div>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {present.map(({ e, a }) => (
              <div key={e.id} className="listrow" style={{ padding: '9px 16px' }}>
                <div><div className="n" style={{ fontSize: 13.5 }}>{e.name}</div><div className="dim">{e.department}</div></div>
                <span className="mono" style={{ fontSize: 13, color: 'var(--soft)' }}>{fmtTime(a?.first_in ?? null, tz)}</span>
              </div>
            ))}
            {present.length === 0 && <div style={{ padding: 16 }} className="sub">No one yet.</div>}
          </div>
        </div>
      </section>
    </>
  );
}
