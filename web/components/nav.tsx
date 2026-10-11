'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

const ITEMS = [
  { href: '/', label: 'Today' },
  { href: '/employees', label: 'Employees' },
  { href: '/punches', label: 'Punch log' },
  { href: '/reports', label: 'Reports & export' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/devices', label: 'Devices & sync' },
  { href: '/settings', label: 'Settings' },
];

export function Nav({ badges }: { badges: Record<string, number> }) {
  const path = usePathname();
  return (
    <>
      <nav className="nav" aria-label="Main">
        {ITEMS.map((i) => {
          const current = i.href === '/' ? path === '/' : path.startsWith(i.href);
          return (
            <Link key={i.href} href={i.href} aria-current={current ? 'page' : undefined}>
              <span>{i.label}</span>
              {badges[i.href] > 0 && <span className="badge">{badges[i.href]}</span>}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

export function SignOut() {
  return (
    <button className="btn ghost small" onClick={async () => { await supabaseBrowser().auth.signOut(); window.location.href = '/login'; }}>
      Sign out
    </button>
  );
}

export function AutoRefresh({ everyMs }: { everyMs: number }) {
  // Re-runs the server component so Today stays current without a manual reload.
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
