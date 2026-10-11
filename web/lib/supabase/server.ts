// Per-request client bound to the signed-in admin's session cookies. RLS applies.
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasAccessSession } from '../accessSession';
import { admin } from './admin';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function supabaseServer(): Promise<SupabaseClient<any, 'attendance'>> {
  // Access-key sessions have no Supabase user for row-level security, so they read as the server.
  if (await hasAccessSession()) return admin();
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      db: { schema: 'attendance' },
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // Called from a Server Component: the proxy refreshes the session instead.
          }
        },
      },
    },
  ) as unknown as SupabaseClient<any, 'attendance'>;
}
