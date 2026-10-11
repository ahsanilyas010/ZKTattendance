// Alert rule evaluation. Each (rule, subject, day) is claimed in alert_events *before* sending, so
// overlapping cron ticks cannot double-send; a failed send releases the claim so the next tick retries.
import { admin } from './supabase/admin';
import { getSettings, getSite } from './settings';
import { sendMail, render } from './mailer';
import { localDate, localParts, zonedToUtc } from './attendance';

interface Rule {
  id: number; site_id: number; name: string; trigger_type: 'late' | 'absent' | 'device_offline' | 'agent_offline' | 'daily_summary';
  threshold_minutes: number; send_at: string | null; department: string | null; employee_id: number | null;
  recipients: string[]; subject_template: string; body_template: string;
}

interface Item { key: string; label: string }

export const DEFAULT_TEMPLATES: Record<Rule['trigger_type'], { subject: string; body: string }> = {
  late: { subject: 'Late arrival: {{names}}', body: '{{count}} employee(s) arrived late on {{date}}:\n\n{{list}}\n' },
  absent: { subject: 'Not clocked in: {{names}}', body: '{{count}} employee(s) have not clocked in on {{date}}:\n\n{{list}}\n' },
  device_offline: { subject: 'Terminal offline: {{names}}', body: 'The following terminal(s) have not been reachable for {{minutes}}+ minutes:\n\n{{list}}\n' },
  agent_offline: { subject: 'Site agent offline: {{names}}', body: 'The on-site sync agent has not checked in for {{minutes}}+ minutes:\n\n{{list}}\n\nPunches are queued on the site PC and will sync when it reconnects.' },
  daily_summary: { subject: 'Attendance summary for {{date}}', body: 'Attendance summary for {{date}}\n\n{{list}}\n' },
};

function inScope(rule: Rule, e: { id: number; department: string }) {
  return (!rule.department || rule.department === e.department) && (!rule.employee_id || rule.employee_id === e.id);
}

async function claim(rule: Rule, items: Item[], date: string): Promise<Item[]> {
  if (!items.length) return [];
  const { data } = await admin().from('alert_events')
    .upsert(items.map((i) => ({ rule_id: rule.id, subject_key: i.key, event_date: date, status: 'sent' })),
      { onConflict: 'rule_id,subject_key,event_date', ignoreDuplicates: true })
    .select('subject_key');
  const won = new Set((data ?? []).map((r) => r.subject_key as string));
  return items.filter((i) => won.has(i.key));
}

async function release(rule: Rule, items: Item[], date: string) {
  await admin().from('alert_events').delete().eq('rule_id', rule.id).eq('event_date', date).in('subject_key', items.map((i) => i.key));
}

async function dispatch(rule: Rule, items: Item[], date: string, vars: Record<string, string | number>): Promise<number> {
  const won = await claim(rule, items, date);
  if (!won.length) return 0;
  const tpl = DEFAULT_TEMPLATES[rule.trigger_type];
  const all = { ...vars, count: won.length, names: won.map((i) => i.label.split(' · ')[0]).join(', '), list: won.map((i) => `• ${i.label}`).join('\n'), date };
  const db = admin();
  try {
    const settings = await getSettings(rule.site_id);
    await sendMail(settings.smtp, {
      to: rule.recipients,
      subject: render(rule.subject_template || tpl.subject, all),
      text: render(rule.body_template || tpl.body, all),
    });
    await db.from('alert_rules').update({ last_sent_at: new Date().toISOString(), last_sent_summary: `${won.length} item(s): ${all.names}`.slice(0, 300) }).eq('id', rule.id);
    return won.length;
  } catch (err) {
    await release(rule, won, date);
    await db.from('alert_rules').update({ last_sent_summary: `Send failed: ${(err as Error).message}`.slice(0, 300) }).eq('id', rule.id);
    return 0;
  }
}

const hm = (d: string | null, tz: string) => {
  if (!d) return '--:--';
  const p = localParts(new Date(d), tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
};

export async function evaluateAlerts(siteId: number, now = new Date()): Promise<{ sent: number }> {
  const db = admin();
  const site = await getSite(siteId);
  const today = localDate(now, site.timezone);
  const { data: rules } = await db.from('alert_rules').select('*').eq('site_id', siteId).eq('enabled', true);
  if (!rules?.length) return { sent: 0 };

  const [{ data: emps }, { data: att }, { data: shifts }, { data: devices }, { data: agents }] = await Promise.all([
    db.from('employees').select('id,name,department,shift_id').eq('site_id', siteId),
    db.from('daily_attendance').select('*').eq('work_date', today),
    db.from('shift_schedules').select('id,start_time,is_default').eq('site_id', siteId),
    db.from('devices').select('id,name,status,last_seen_at,created_at').eq('site_id', siteId).eq('enabled', true),
    db.from('agents').select('id,name,last_seen_at,created_at').eq('site_id', siteId),
  ]);
  const empById = new Map((emps ?? []).map((e) => [e.id as number, e]));
  const shiftById = new Map((shifts ?? []).map((s) => [s.id as number, s]));
  const defaultShift = (shifts ?? []).find((s) => s.is_default) ?? (shifts ?? [])[0];
  let sent = 0;

  for (const rule of rules as Rule[]) {
    const mins = rule.threshold_minutes;
    switch (rule.trigger_type) {
      case 'late': {
        const items = (att ?? []).filter((a) => a.is_late && a.late_minutes >= mins).flatMap((a) => {
          const e = empById.get(a.employee_id);
          return e && inScope(rule, e) ? [{ key: `emp:${e.id}`, label: `${e.name} · ${e.department} · in at ${hm(a.first_in, site.timezone)} (+${a.late_minutes} min)` }] : [];
        });
        sent += await dispatch(rule, items, today, {});
        break;
      }
      case 'absent': {
        const items = (att ?? []).filter((a) => a.is_absent).flatMap((a) => {
          const e = empById.get(a.employee_id);
          if (!e || !inScope(rule, e)) return [];
          const shift = shiftById.get(a.shift_id ?? e.shift_id) ?? defaultShift;
          // Wait until `mins` after the shift start, even if the shift's own absence cutoff passed sooner.
          const due = shift ? zonedToUtc(today, shift.start_time, site.timezone).getTime() + mins * 60_000 : 0;
          return now.getTime() >= due ? [{ key: `emp:${e.id}`, label: `${e.name} · ${e.department} · due ${shift ? String(shift.start_time).slice(0, 5) : ''}` }] : [];
        });
        sent += await dispatch(rule, items, today, {});
        break;
      }
      case 'device_offline': {
        const items = (devices ?? []).filter((d) => {
          const ref = d.last_seen_at ?? d.created_at;
          return d.status !== 'online' && now.getTime() - new Date(ref).getTime() >= mins * 60_000;
        }).map((d) => ({ key: `dev:${d.id}`, label: `${d.name} · last seen ${d.last_seen_at ? hm(d.last_seen_at, site.timezone) : 'never'}` }));
        sent += await dispatch(rule, items, today, { minutes: mins });
        break;
      }
      case 'agent_offline': {
        const items = (agents ?? []).filter((a) => now.getTime() - new Date(a.last_seen_at ?? a.created_at).getTime() >= mins * 60_000)
          .map((a) => ({ key: `agent:${a.id}`, label: `${a.name} · last seen ${a.last_seen_at ? hm(a.last_seen_at, site.timezone) : 'never'}` }));
        sent += await dispatch(rule, items, today, { minutes: mins });
        break;
      }
      case 'daily_summary': {
        const p = localParts(now, site.timezone);
        const at = (rule.send_at ?? '18:00').split(':').map(Number);
        if (p.h * 60 + p.min < at[0] * 60 + at[1]) break;
        const scoped = (att ?? []).filter((a) => { const e = empById.get(a.employee_id); return e && inScope(rule, e); });
        const name = (a: { employee_id: number }) => empById.get(a.employee_id)!.name;
        const lines = [
          `Present: ${scoped.filter((a) => !a.is_absent && !a.is_leave && !a.is_holiday && a.punch_count > 0).length}`,
          `Late: ${scoped.filter((a) => a.is_late).length}${scoped.some((a) => a.is_late) ? ' (' + scoped.filter((a) => a.is_late).map(name).join(', ') + ')' : ''}`,
          `Absent: ${scoped.filter((a) => a.is_absent).length}${scoped.some((a) => a.is_absent) ? ' (' + scoped.filter((a) => a.is_absent).map(name).join(', ') + ')' : ''}`,
          `On leave: ${scoped.filter((a) => a.is_leave).length}`,
        ];
        sent += await dispatch(rule, [{ key: 'summary', label: lines.join('\n• ') }], today, {});
        break;
      }
    }
  }
  return { sent };
}

/** Sends a sample email for a rule so the admin can check recipients and wording. */
export async function sendRuleTest(ruleId: number): Promise<void> {
  const { data: rule } = await admin().from('alert_rules').select('*').eq('id', ruleId).single();
  if (!rule) throw new Error('Rule not found');
  const r = rule as Rule;
  const tpl = DEFAULT_TEMPLATES[r.trigger_type];
  const vars = { count: 1, names: 'Sample Employee', list: '• Sample Employee · Office · in at 09:23 (+23 min)', date: 'today', minutes: r.threshold_minutes };
  const settings = await getSettings(r.site_id);
  await sendMail(settings.smtp, {
    to: r.recipients,
    subject: '[Test] ' + render(r.subject_template || tpl.subject, vars),
    text: 'This is a test of the alert rule "' + r.name + '".\n\n' + render(r.body_template || tpl.body, vars),
  });
}
