import "server-only";

import { cache } from "react";
import { hasSupabaseConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

export type Session = { userId: string; email: string | null } | null;

/**
 * The signed-in Supabase user for a server render.
 *
 * User-owned surfaces (watchlist, readiness milestones, calendar, digests) are
 * only ever rendered from records owned by this identity. A missing session is
 * a real signed-out state, never a reason to substitute fixture user data.
 *
 * Memoized per render with React's `cache`, so the header and the page share one Supabase Auth call; outside a render
 * (a route handler) every call reads afresh.
 */
export const currentSession = cache(async function currentSession(): Promise<Session> {
  if (!hasSupabaseConfig()) return null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { userId: data.user.id, email: data.user.email ?? null };
  } catch {
    // A malformed or expired cookie is a signed-out session, not a render failure.
    return null;
  }
});
