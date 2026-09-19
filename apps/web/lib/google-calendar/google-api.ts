import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/paging";
import { decryptToken, encryptToken } from "./crypto";
import { getGoogleCalendarConfig } from "./config";
import type { GoogleEvent } from "./events";

type Connection = {
  calendar_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  token_expires_at: string;
};

async function refreshAccessToken(userId: string, connection: Connection) {
  const config = getGoogleCalendarConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: await decryptToken(connection.refresh_token_ciphertext, userId),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const code = response.status === 400 ? "google_reauthorization_required" : "google_token_refresh_failed";
    await createAdminClient().from("google_calendar_connections").update({ last_error_code: code, last_error_at: new Date().toISOString() }).eq("user_id", userId);
    throw new Error(code);
  }
  const token = await response.json() as { access_token: string; expires_in?: number };
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  await createAdminClient().from("google_calendar_connections").update({
    access_token_ciphertext: await encryptToken(token.access_token, userId),
    token_expires_at: expiresAt,
    last_error_code: null,
    last_error_at: null,
  }).eq("user_id", userId);
  return token.access_token;
}

export async function getCalendarAccess(userId: string) {
  const admin = createAdminClient();
  // bounded: one row; google_calendar_connections is keyed by user_id.
  const result = await admin.from("google_calendar_connections").select("calendar_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at").eq("user_id", userId).maybeSingle();
  if (result.error) throw new Error("calendar_connection_read_failed");
  if (!result.data) throw new Error("google_calendar_not_connected");
  const connection = result.data as Connection;
  const accessToken = new Date(connection.token_expires_at).getTime() <= Date.now() + 60_000
    ? await refreshAccessToken(userId, connection)
    : await decryptToken(connection.access_token_ciphertext, userId);
  return { accessToken, calendarId: connection.calendar_id };
}

export async function googleEventRequest(
  method: "POST" | "PUT" | "DELETE",
  accessToken: string,
  calendarId: string,
  event?: GoogleEvent,
  eventId?: string,
) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const response = await fetch(eventId ? `${base}/${encodeURIComponent(eventId)}` : base, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(event ? { "Content-Type": "application/json" } : {}) },
    body: event ? JSON.stringify(event) : undefined,
  });
  // Deleting an event that is already gone is done: Google answers 404, or 410 for an event it has marked deleted.
  if (!response.ok && !(method === "DELETE" && (response.status === 404 || response.status === 410))) {
    const error = new Error(response.status === 401 ? "google_reauthorization_required" : "google_calendar_write_failed");
    Object.assign(error, { status: response.status });
    throw error;
  }
}

/**
 * Delete every event 1stSeen synced into the user's Google Calendar and still tracks as active. Stops at the first
 * failure and throws, so a caller can tell the user that the events were not all removed. Returns how many it removed.
 * Used by the calendar disconnect and by account deletion.
 */
export async function deleteSyncedGoogleEvents(userId: string): Promise<number> {
  const access = await getCalendarAccess(userId);
  const admin = createAdminClient();
  // A user can hold more synced events than one PostgREST response returns, so the mapping read pages.
  const mappings = await fetchAll<{ google_calendar_id: string; google_event_id: string }>(
    () => admin.from("calendar_event_syncs").select("google_calendar_id,google_event_id").eq("user_id", userId).eq("provider", "google").eq("status", "active").order("google_event_id"),
    "calendar_mapping",
    "id",
  );
  for (const mapping of mappings) {
    await googleEventRequest("DELETE", access.accessToken, mapping.google_calendar_id, undefined, mapping.google_event_id);
  }
  return mappings.length;
}
