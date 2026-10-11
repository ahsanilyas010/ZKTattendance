import { createBrowserClient } from '@supabase/ssr';

/** True when this browser signed in with the shared access key (the cookie is a non-secret marker). */
export function isKeyMode(): boolean {
  return typeof document !== 'undefined' && document.cookie.split('; ').includes('zk_mode=key');
}

export function supabaseBrowser() {
  // Access-key sessions route data calls through this app's /api/sb forwarder (it checks the signed cookie);
  // email sessions talk to Supabase directly under row-level security.
  const keyMode = isKeyMode();
  const url = keyMode ? `${window.location.origin}/api/sb` : process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return createBrowserClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    db: { schema: 'attendance' },
    ...(keyMode ? { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } : {}),
  });
}
