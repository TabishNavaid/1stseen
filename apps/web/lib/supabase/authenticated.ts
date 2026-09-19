import "server-only";

import { hasSupabaseConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

export async function authenticatedUser() {
  if (!hasSupabaseConfig()) {
    return { response: Response.json({ error: "supabase_unavailable" }, { status: 503 }) } as const;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { response: Response.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  return { userId: data.user.id } as const;
}
