import { admin } from './supabase/admin';
import { getSettings, getSite } from './settings';
import { sendMail } from './mailer';
import { buildWorkbook, loadExportData, resolveRange, summaryLine, type DateRangeKey } from './exports';
import { localDate, localParts, zonedToUtc } from './attendance';

interface Template {
  id: number; site_id: number; name: string; kind: 'raw' | 'daily' | 'both'; date_range: DateRangeKey;
  department: string | null; employee_id: number | null; late_absent_only: boolean;
  frequency: 'daily' | 'weekly' | 'monthly'; weekday: number | null; day_of_month: number | null;
  run_at: string; recipients: string[]; last_run_at: string | null;
}

function isDue(t: Template, now: Date, tz: string): boolean {
  const p = localParts(now, tz);
  const today = localDate(now, tz);
  const [h, m] = t.run_at.split(':').map(Number);
  if (p.h * 60 + p.min < h * 60 + m) return false;
  if (t.last_run_at && localDate(new Date(t.last_run_at), tz) === today) return false;
  if (t.frequency === 'weekly') return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() === (t.weekday ?? 1);
  if (t.frequency === 'monthly') return p.d === (t.day_of_month ?? 1);
  return true;
}

export async function runExportTemplate(t: Template, now = new Date()): Promise<string> {
  const site = await getSite(t.site_id);
  const range = resolveRange(t.date_range, site.timezone, now);
  const data = await loadExportData({
    siteId: t.site_id, ...range, department: t.department, employeeId: t.employee_id, lateAbsentOnly: t.late_absent_only, kind: t.kind,
  });
  const file = await buildWorkbook(data, t.kind);
  const settings = await getSettings(t.site_id);
  const label = range.from === range.to ? range.from : `${range.from} to ${range.to}`;
  await sendMail(settings.smtp, {
    to: t.recipients,
    subject: `${t.name}: ${label}`,
    text: `${t.name} for ${label}\n\n${summaryLine(data)}\n\nThe Excel file is attached.`,
    attachments: [{ filename: `attendance_${range.from}_${range.to}.xlsx`, content: file, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });
  return summaryLine(data);
}

export async function runDueExports(siteId: number, now = new Date()): Promise<number> {
  const db = admin();
  const site = await getSite(siteId);
  const { data } = await db.from('export_templates').select('*').eq('site_id', siteId).eq('enabled', true);
  let ran = 0;
  for (const t of (data ?? []) as Template[]) {
    if (!isDue(t, now, site.timezone)) continue;
    // Claim the run by stamping last_run_at only if it still has the value we read.
    const claim = db.from('export_templates').update({ last_run_at: now.toISOString(), last_status: 'running' }).eq('id', t.id);
    const { data: won } = await (t.last_run_at ? claim.eq('last_run_at', t.last_run_at) : claim.is('last_run_at', null)).select('id');
    if (!won?.length) continue;
    try {
      const summary = await runExportTemplate(t, now);
      await db.from('export_templates').update({ last_status: `Sent: ${summary}`.slice(0, 300) }).eq('id', t.id);
      await db.from('export_jobs').insert({ template_id: t.id, params: { range: t.date_range }, status: 'done' });
      ran++;
    } catch (err) {
      // Roll the claim back so the next tick retries (e.g. SMTP was down).
      await db.from('export_templates').update({ last_run_at: t.last_run_at, last_status: `Failed: ${(err as Error).message}`.slice(0, 300) }).eq('id', t.id);
      await db.from('export_jobs').insert({ template_id: t.id, params: { range: t.date_range }, status: 'failed', error: (err as Error).message });
    }
  }
  return ran;
}
export { zonedToUtc };
