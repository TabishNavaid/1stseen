import "server-only";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const serviceConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(20),
});

export function createAdminClient() {
  const { supabaseUrl, supabaseServiceRoleKey } = serviceConfigSchema.parse({
    supabaseUrl: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
