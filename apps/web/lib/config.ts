import { z } from "zod";

const publicConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseAnonKey: z.string().min(20),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;

export function getPublicConfig(): PublicConfig {
  return publicConfigSchema.parse({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

const contactEmailSchema = z.string().trim().pipe(z.email().max(254));

/**
 * The one contact address the terms, privacy, data-source, and contact pages give (FIRSTSEEN_CONTACT_EMAIL), read on the
 * server at request time. Null when this deployment sets none, or sets something that is not one plain address; the
 * pages then say no address is configured rather than inventing one.
 */
export function getContactEmail(): string | null {
  const parsed = contactEmailSchema.safeParse(process.env.FIRSTSEEN_CONTACT_EMAIL);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether collection honours robots.txt: ROBOTS_TXT_ENFORCED, the variable the worker reads (worker/src/firstseen/robots.py).
 * Off unless it is exactly "true", which is also the worker's default, so /data-sources never claims more than collection does.
 */
export function collectionHonoursRobotsTxt(): boolean {
  return process.env.ROBOTS_TXT_ENFORCED === "true";
}
