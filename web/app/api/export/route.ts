import { z } from 'zod';
import { buildWorkbook, loadExportData } from '@/lib/exports';
import { bad, currentSiteId, requireAdmin } from '@/lib/auth';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Q = z.object({
  from: date, to: date, kind: z.enum(['raw', 'daily', 'both']).default('daily'),
  department: z.string().optional(), employeeId: z.coerce.number().int().optional(),
  lateAbsentOnly: z.enum(['0', '1']).optional(),
});

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return bad('Choose a valid date range.');
  if (q.data.to < q.data.from) return bad('"To" must not be before "From".');
  const data = await loadExportData({
    siteId: await currentSiteId(), from: q.data.from, to: q.data.to, kind: q.data.kind,
    department: q.data.department && q.data.department !== 'All departments' ? q.data.department : null,
    employeeId: q.data.employeeId ?? null, lateAbsentOnly: q.data.lateAbsentOnly === '1',
  });
  const file = await buildWorkbook(data, q.data.kind);
  return new Response(new Uint8Array(file), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="attendance_${q.data.from}_${q.data.to}.xlsx"`,
      'cache-control': 'no-store',
    },
  });
}
