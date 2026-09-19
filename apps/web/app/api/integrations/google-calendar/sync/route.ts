import { httpUrlSchema } from "@firstseen/shared";
import { z } from "zod";
import { authenticatedUser } from "@/lib/google-calendar/auth";
import { getCalendarAccess, googleEventRequest } from "@/lib/google-calendar/google-api";
import { selectableCalendarEventTypes, syncSelectedEvent } from "@/lib/google-calendar/events";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const selectedEventSchema = z.object({
  sourceKey: z.string().min(1).max(200),
  eventType: z.enum(selectableCalendarEventTypes),
  date: z.iso.date(),
  endDate: z.iso.date().optional(),
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(300),
  label: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000),
  confidence: z.number().int().min(0).max(100).optional(),
  roleUrl: httpUrlSchema,
}).strict();
const requestSchema = z.object({ events: z.array(selectedEventSchema).min(1).max(50) }).strict();

export async function POST(request: Request) {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_calendar_sync_request" }, { status: 400 });
  try {
    const { accessToken, calendarId } = await getCalendarAccess(auth.userId);
    const admin = createAdminClient();
    const results = [];
    for (const event of parsed.data.events) {
      const result = await syncSelectedEvent(event, auth.userId, {
        find: async (sourceKey, sourceKind) => {
          // bounded: one row; unique on (user_id, provider, source_kind, source_key).
          const found = await admin.from("calendar_event_syncs").select("google_event_id,event_fingerprint").eq("user_id", auth.userId).eq("provider", "google").eq("source_kind", sourceKind).eq("source_key", sourceKey).maybeSingle();
          if (found.error) throw new Error("calendar_mapping_read_failed");
          return found.data ? { googleEventId: found.data.google_event_id, fingerprint: found.data.event_fingerprint } : null;
        },
        insert: async (googleEvent) => {
          try {
            await googleEventRequest("POST", accessToken, calendarId, googleEvent);
          } catch (error) {
            if ((error as { status?: number }).status !== 409) throw error;
            await googleEventRequest("PUT", accessToken, calendarId, googleEvent, googleEvent.id);
          }
        },
        update: async (eventId, googleEvent) => {
          try {
            await googleEventRequest("PUT", accessToken, calendarId, googleEvent, eventId);
          } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
            // A user may delete the external event directly. Recreate the same stable ID, never a duplicate.
            await googleEventRequest("POST", accessToken, calendarId, { ...googleEvent, id: eventId });
          }
        },
        save: async (mapping) => {
          const saved = await admin.from("calendar_event_syncs").upsert({
            user_id: auth.userId,
            provider: "google",
            source_kind: mapping.sourceKind,
            source_key: mapping.sourceKey,
            google_calendar_id: calendarId,
            google_event_id: mapping.googleEventId,
            event_fingerprint: mapping.fingerprint,
            status: "active",
            last_synced_at: new Date().toISOString(),
            last_error_code: null,
          }, { onConflict: "user_id,provider,source_kind,source_key" });
          if (saved.error) throw new Error("calendar_mapping_save_failed");
        },
      });
      results.push({ source_key: event.sourceKey, action: result.action });
    }
    return Response.json({ results });
  } catch (error) {
    const code = error instanceof Error ? error.message : "google_calendar_sync_failed";
    return Response.json({ error: code }, { status: code === "google_calendar_not_connected" ? 409 : 502 });
  }
}
