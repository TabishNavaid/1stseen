import "server-only";

import { z } from "zod";

const schema = z.object({
  clientId: z.string().min(10),
  clientSecret: z.string().min(10),
  redirectUri: z.string().url(),
  tokenEncryptionKey: z.string().min(43),
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(20),
});

export type GoogleCalendarConfig = z.infer<typeof schema>;

export function hasGoogleCalendarConfig() {
  return Boolean(
    process.env.GOOGLE_CALENDAR_CLIENT_ID &&
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REDIRECT_URI &&
    process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function getGoogleCalendarConfig(): GoogleCalendarConfig {
  return schema.parse({
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
    tokenEncryptionKey: process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
    supabaseUrl: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
