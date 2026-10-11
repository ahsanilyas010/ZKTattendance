import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, configuredKey, verifyToken } from '@/lib/access';

// Refreshes the Supabase session and sends signed-out visitors to /login.
// /api/agent/* and /api/jobs/* authenticate themselves (agent key / cron secret) and are excluded below.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Either a valid shared-access-key cookie or a Supabase administrator session lets you in.
  const keyOk = verifyToken(request.cookies.get(ACCESS_COOKIE)?.value, configuredKey());
  const claims = keyOk ? null : (await supabase.auth.getClaims()).data;
  const isAdmin = keyOk || claims?.claims?.app_metadata?.role === 'admin';
  const { pathname } = request.nextUrl;

  if (!isAdmin && pathname !== '/login' && pathname !== '/api/access/login') {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  if (isAdmin && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ['/((?!api/agent/|api/jobs/|_next/static|_next/image|favicon.ico).*)'],
};
