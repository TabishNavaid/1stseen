import { z } from "zod";
import { authenticatedUser } from "@/lib/google-calendar/auth";
import { hasGoogleCalendarConfig } from "@/lib/google-calendar/config";
import { decryptToken } from "@/lib/google-calendar/crypto";
import { deleteSyncedGoogleEvents } from "@/lib/google-calendar/google-api";
import { revokeGoogleToken } from "@/lib/google-revocation";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/paging";

export const runtime = "nodejs";

export async function GET() {
  if (!hasGoogleCalendarConfig()) {
    return Response.json({ configured: false, connected: false, synced_source_keys: [] });
  }
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  const admin = createAdminClient();
  // A user can hold more synced events than one PostgREST response returns, so the mapping read pages.
  const [connection, mappings] = await Promise.all([
    // bounded: one row; google_calendar_connections is keyed by user_id.
    admin.from("google_calendar_connections").select("google_account_label,connected_at,last_error_code").eq("user_id", auth.userId).maybeSingle(),
    fetchAll<{ source_key: string }>(
      () => admin.from("calendar_event_syncs").select("source_key").eq("user_id", auth.userId).eq("provider", "google").eq("status", "active").order("source_key"),
      "calendar_mapping",
      "id",
    ).catch(() => null),
  ]);
  if (connection.error || !mappings) return Response.json({ error: "calendar_status_failed" }, { status: 500 });
  return Response.json({
    configured: true,
    connected: Boolean(connection.data),
    account_label: connection.data?.google_account_label ?? null,
    connected_at: connection.data?.connected_at ?? null,
    connection_error: connection.data?.last_error_code ?? null,
    synced_source_keys: mappings.map((item) => item.source_key),
  });
}

const disconnectSchema = z.object({ remove_synced_events: z.boolean().default(false) }).strict();

export async function DELETE(request: Request) {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGoogleCalendarConfig()) return new Response(null, { status: 204 });
  const parsed = disconnectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "invalid_disconnect_request" }, { status: 400 });
  const admin = createAdminClient();
  // bounded: one row; google_calendar_connections is keyed by user_id.
  const connection = await admin.from("google_calendar_connections").select("refresh_token_ciphertext").eq("user_id", auth.userId).maybeSingle();
  if (connection.error) return Response.json({ error: "calendar_connection_read_failed" }, { status: 500 });
  if (!connection.data) return new Response(null, { status: 204 });
  if (parsed.data.remove_synced_events) {
    try {
      await deleteSyncedGoogleEvents(auth.userId);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "calendar_disconnect_failed" }, { status: 502 });
    }
  }
  try {
    await revokeGoogleToken(await decryptToken(connection.data.refresh_token_ciphertext, auth.userId));
  } catch {
    // Local credential deletion still completes if Google's best-effort revocation endpoint is unavailable.
  }
  const mappingMutation = parsed.data.remove_synced_events
    ? admin.from("calendar_event_syncs").delete().eq("user_id", auth.userId).eq("provider", "google")
    : admin.from("calendar_event_syncs").update({ status: "detached" }).eq("user_id", auth.userId).eq("provider", "google");
  const [mappingResult, connectionResult] = await Promise.all([
    mappingMutation,
    admin.from("google_calendar_connections").delete().eq("user_id", auth.userId),
  ]);
  if (mappingResult.error || connectionResult.error) return Response.json({ error: "calendar_disconnect_storage_failed" }, { status: 500 });
  return new Response(null, { status: 204 });
}
