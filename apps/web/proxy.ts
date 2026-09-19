import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions } from "@/lib/auth/policy";

// Auth routes manage their own cookies, and static files never carry a session. Checked here
// rather than with `config.matcher`, whose path syntax vinext parses more strictly than Next.js.
const SKIPPED_PATHS = /^\/(?:api\/auth\/|api\/health$|assets\/)|\.(?:css|js|map|png|jpe?g|gif|svg|webp|ico|txt|xml|woff2?)$/;

/**
 * Keep the Supabase session fresh at the request boundary.
 *
 * Server Components cannot write cookies, so a token refreshed during a render is never
 * saved and the next render refreshes again. Here the refreshed cookies are written to both
 * the forwarded request (so this render sees them) and the response (so the browser keeps
 * them). `getSession()` refreshes only when the access token is near expiry, so a fresh
 * session costs no network call; identity is still verified with `getUser()` wherever the
 * app acts on it.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || SKIPPED_PATHS.test(new URL(request.url).pathname)) return NextResponse.next();
  if (!request.cookies.getAll().some((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token"))) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request: { headers: request.headers } });
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions(process.env.NEXT_PUBLIC_APP_URL),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        for (const { name, value } of items) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: request.headers } });
        for (const { name, value, options } of items) response.cookies.set(name, value, options);
      },
    },
  });
  try {
    await supabase.auth.getSession();
  } catch {
    // An unreadable or revoked session is a signed-out render, not a failed request.
  }
  return response;
}
