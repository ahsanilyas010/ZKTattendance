// Service-role client. Bypasses RLS: only import from server-only code (agent API, cron, exports).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient<any, 'attendance'> | null = null;

export function admin(): SupabaseClient<any, 'attendance'> {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    client = createClient(url, key, { db: { schema: 'attendance' }, auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}
