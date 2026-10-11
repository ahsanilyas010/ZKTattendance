import ExcelJS from 'exceljs';
import { admin } from './supabase/admin';
import { getSettings } from './settings';
import { fetchAll } from './recompute';
import { addDays, dedupePunches, formatHours, localParts, zonedToUtc } from './attendance';

export { resolveRange, type DateRangeKey } from './ranges';

export interface ExportFilter {
  siteId: number; from: string; to: string;
  department?: string | null; employeeId?: number | null; lateAbsentOnly?: boolean;
  kind: 'raw' | 'daily' | 'both';
}

interface DailyRow {
  date: string; name: string; deviceId: string; department: string; shift: string;
  firstIn: Date | null; lastOut: Date | null; workedMinutes: number | null;
  late: boolean; lateMinutes: number; earlyLeave: boolean; absent: boolean; status: string;
}
interface RawRow { at: Date; name: string; location: string; deviceUserId: string; method: string; duplicate: boolean }

export interface ExportData { tz: string; daily: DailyRow[]; raw: RawRow[]; totals: { late: number; absent: number; minutes: number } }

export async function loadExportData(f: ExportFilter): Promise<ExportData> {
  const db = admin();
  const { data: site } = await db.from('sites').select('timezone').eq('id', f.siteId).single();
  const tz = site!.timezone as string;
  const settings = await getSettings(f.siteId);

  let eq = db.from('employees').select('id,name,device_user_id,department,shift_schedules(name)').eq('site_id', f.siteId);
  if (f.department) eq = eq.eq('department', f.department);
  if (f.employeeId) eq = eq.eq('id', f.employeeId);
  const { data: emps, error } = await eq;
  if (error) throw error;
  const byId = new Map((emps ?? []).map((e) => [e.id as number, e]));
  const ids = [...byId.keys()];

  const daily: DailyRow[] = [];
  if (f.kind !== 'raw' && ids.length) {
    const rows = await fetchAll<Record<string, any>>((a, b) =>
      db.from('daily_attendance').select('*').in('employee_id', ids).gte('work_date', f.from).lte('work_date', f.to)
        .order('work_date').order('id').range(a, b));
    for (const r of rows) {
      const e = byId.get(r.employee_id)!;
      const late = r.is_late, absent = r.is_absent;
      if (f.lateAbsentOnly && !late && !absent) continue;
      daily.push({
        date: r.work_date, name: e.name, deviceId: e.device_user_id ?? '', department: e.department,
        shift: (e as any).shift_schedules?.name ?? '',
        firstIn: r.first_in ? new Date(r.first_in) : null, lastOut: r.last_out ? new Date(r.last_out) : null,
        workedMinutes: r.worked_minutes, late, lateMinutes: r.late_minutes, earlyLeave: r.is_early_leave, absent,
        status: absent ? 'Absent' : r.is_leave ? 'On leave' : r.is_holiday ? 'Holiday' : late ? 'Late'
          : r.single_punch ? 'Single punch' : 'Present',
      });
    }
    daily.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }

  const raw: RawRow[] = [];
  if (f.kind !== 'daily') {
    const lo = zonedToUtc(f.from, '00:00', tz).toISOString();
    const hi = zonedToUtc(addDays(f.to, 1), '00:00', tz).toISOString();
    const filtered = !!(f.department || f.employeeId);
    let pq = (a: number, b: number) => {
      let q = db.from('raw_punches').select('id,employee_id,device_user_id,punched_at,verify_method,devices(name,location)')
        .eq('site_id', f.siteId).gte('punched_at', lo).lt('punched_at', hi);
      if (filtered) q = q.in('employee_id', ids.length ? ids : [-1]);
      return q.order('punched_at').order('id').range(a, b);
    };
    const rows = await fetchAll<Record<string, any>>(pq);
    // Flag the punches the daily summary ignores as duplicates, so the two sheets reconcile.
    const dupIds = new Set<number>();
    const perEmp = new Map<string, Record<string, any>[]>();
    for (const r of rows) {
      const k = r.employee_id ? `e${r.employee_id}` : `u${r.device_user_id}`;
      (perEmp.get(k) ?? perEmp.set(k, []).get(k)!).push(r);
    }
    for (const list of perEmp.values()) {
      const kept = new Set(dedupePunches(list.map((r) => new Date(r.punched_at)), settings.dedupe_window_sec).map((d) => d.getTime()));
      const seen = new Set<number>();
      for (const r of list) {
        const t = new Date(r.punched_at).getTime();
        if (kept.has(t) && !seen.has(t)) seen.add(t); else dupIds.add(r.id);
      }
    }
    for (const r of rows) {
      const e = r.employee_id ? byId.get(r.employee_id) : null;
      raw.push({
        at: new Date(r.punched_at), name: e?.name ?? 'Unknown ID', deviceUserId: r.device_user_id,
        location: r.devices?.location || r.devices?.name || '', method: r.verify_method ?? '', duplicate: dupIds.has(r.id),
      });
    }
  }

  const totals = {
    late: daily.filter((d) => d.late).length,
    absent: daily.filter((d) => d.absent).length,
    minutes: daily.reduce((s, d) => s + (d.workedMinutes ?? 0), 0),
  };
  return { tz, daily, raw, totals };
}

/** Excel has no time zones, so write the site's wall-clock time as if it were UTC. */
function wall(d: Date | null, tz: string): Date | null {
  if (!d) return null;
  const p = localParts(d, tz);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s));
}

function styleSheet(ws: ExcelJS.Worksheet, widths: number[]) {
  ws.columns.forEach((c, i) => { c.width = widths[i]; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEB' } };
}

export async function buildWorkbook(data: ExportData, kind: 'raw' | 'daily' | 'both'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  if (kind !== 'raw') {
    const ws = wb.addWorksheet('Daily summary');
    ws.columns = [
      { header: 'Date' }, { header: 'Employee' }, { header: 'ID Number' }, { header: 'Department' }, { header: 'Shift' },
      { header: 'First in' }, { header: 'Last out' }, { header: 'Hours worked' }, { header: 'Status' },
      { header: 'Late' }, { header: 'Late by (min)' }, { header: 'Early leave' }, { header: 'Absent' },
    ];
    for (const d of data.daily) {
      ws.addRow([
        new Date(`${d.date}T00:00:00Z`), d.name, d.deviceId, d.department, d.shift, wall(d.firstIn, data.tz), wall(d.lastOut, data.tz),
        d.workedMinutes == null ? null : Math.round((d.workedMinutes / 60) * 100) / 100, d.status,
        d.late ? 'Yes' : '', d.late ? d.lateMinutes : null, d.earlyLeave ? 'Yes' : '', d.absent ? 'Yes' : '',
      ]);
    }
    ws.getColumn(1).numFmt = 'yyyy-mm-dd';
    ws.getColumn(6).numFmt = 'hh:mm'; ws.getColumn(7).numFmt = 'hh:mm'; ws.getColumn(8).numFmt = '0.00';
    styleSheet(ws, [12, 24, 11, 16, 14, 9, 9, 13, 14, 7, 13, 12, 8]);
  }
  if (kind !== 'daily') {
    const ws = wb.addWorksheet('Raw punches');
    ws.columns = [
      { header: 'Name' }, { header: 'Date/Time' }, { header: 'Location/Device ID' }, { header: 'ID Number' },
      { header: 'Verified by' }, { header: 'Duplicate' },
    ];
    for (const r of data.raw) ws.addRow([r.name, wall(r.at, data.tz), r.location, r.deviceUserId, r.method, r.duplicate ? 'Yes' : '']);
    ws.getColumn(2).numFmt = 'yyyy-mm-dd hh:mm:ss';
    styleSheet(ws, [24, 20, 22, 11, 13, 10]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const summaryLine = (d: ExportData) =>
  `${d.daily.length} daily rows, ${d.raw.length} raw punches, ${d.totals.late} late, ${d.totals.absent} absent, ${formatHours(d.totals.minutes)} worked`;
