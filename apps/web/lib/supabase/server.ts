import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicConfig } from "@/lib/config";
import { authCookieOptions } from "@/lib/auth/policy";

export async function createClient() {
  const config = getPublicConfig();
  const cookieStore = await cookies();
  return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    // Every auth call runs on the server, so no page script ever needs to read the session.
    cookieOptions: authCookieOptions(process.env.NEXT_PUBLIC_APP_URL),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          items.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies; auth refresh belongs in a request boundary.
        }
      },
    },
  });
}
