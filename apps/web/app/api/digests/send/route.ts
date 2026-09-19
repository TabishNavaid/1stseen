import { authenticatedUser } from "@/lib/supabase/authenticated";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEmailDigestConfig, hasGmailConfig } from "@/lib/email-digests/config";
import { loadDigestSourceData } from "@/lib/email-digests/data";
import { buildEmailDigest, renderDigestHtml } from "@/lib/email-digests/digest";
import { getGmailAccess, sendGmailMessage } from "@/lib/email-digests/gmail-api";

export const runtime = "nodejs";

export async function POST() {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGmailConfig()) return Response.json({ error: "gmail_unavailable" }, { status: 503 });
  if (!getEmailDigestConfig().sendEnabled) return Response.json({ error: "email_delivery_disabled" }, { status: 403 });
  try {
    const digest = await buildEmailDigest(await loadDigestSourceData(auth.userId));
    if (!digest.items.length) return Response.json({ error: "digest_has_no_items" }, { status: 409 });
    const gmail = await getGmailAccess(auth.userId);
    const html = renderDigestHtml(digest);
    const admin = createAdminClient();
    let deliveryId: string;
    const created = await admin.from("email_digest_deliveries").insert({
      user_id: auth.userId,
      channel: "gmail",
      digest_version: digest.version,
      period_start: digest.periodStart,
      period_end: digest.periodEnd,
      as_of: digest.asOf,
      input_fingerprint: digest.fingerprint,
      recipient_email: gmail.email,
      subject: digest.subject,
      structured_payload: digest,
      rendered_html: html,
      status: "sending",
    }).select("id").single();
    if (created.error) {
      if (created.error.code !== "23505") throw new Error("digest_delivery_create_failed");
      // bounded: one row; unique on (user_id, channel, input_fingerprint).
      const existing = await admin.from("email_digest_deliveries").select("id,status").eq("user_id", auth.userId).eq("channel", "gmail").eq("input_fingerprint", digest.fingerprint).single();
      if (existing.error) throw new Error("digest_delivery_read_failed");
      if (existing.data.status === "sent") return Response.json({ error: "digest_already_delivered" }, { status: 409 });
      if (existing.data.status === "sending") return Response.json({ error: "digest_delivery_in_progress" }, { status: 409 });
      deliveryId = existing.data.id;
      const reset = await admin.from("email_digest_deliveries").update({ status: "sending", failure_code: null, attempted_at: new Date().toISOString(), recipient_email: gmail.email, subject: digest.subject, structured_payload: digest, rendered_html: html }).eq("id", deliveryId).eq("user_id", auth.userId);
      if (reset.error) throw new Error("digest_delivery_retry_failed");
      await admin.from("email_digest_items").delete().eq("delivery_id", deliveryId);
    } else {
      deliveryId = created.data.id;
    }
    const itemRows = digest.items.map((item) => ({
      delivery_id: deliveryId,
      item_key: item.itemKey,
      kind: item.kind,
      canonical_role_id: item.canonicalRoleId,
      forecast_id: item.forecastId ?? null,
      forecast_change_id: item.forecastChangeId ?? null,
      historical_opening_event_id: item.historicalOpeningEventId ?? null,
      readiness_milestone_id: item.readinessMilestoneId ?? null,
      event_on: item.eventOn,
      payload: item,
    }));
    const itemInsert = await admin.from("email_digest_items").insert(itemRows);
    if (itemInsert.error) {
      await admin.from("email_digest_deliveries").update({ status: "failed", failure_code: "digest_items_save_failed" }).eq("id", deliveryId);
      throw new Error("digest_items_save_failed");
    }
    let externalMessageId: string;
    try {
      externalMessageId = await sendGmailMessage(gmail.accessToken, gmail.email, digest.subject, html);
    } catch (error) {
      await admin.from("email_digest_deliveries").update({ status: "failed", failure_code: error instanceof Error ? error.message : "gmail_send_failed" }).eq("id", deliveryId);
      throw error;
    }
    const saved = await admin.from("email_digest_deliveries").update({ status: "sent", external_message_id: externalMessageId, sent_at: new Date().toISOString(), failure_code: null }).eq("id", deliveryId).eq("user_id", auth.userId);
    // If confirmation persistence fails, leave the row in `sending`. A retry is blocked to favor
    // duplicate prevention over an unsafe second send; an operator can reconcile the Gmail ID.
    if (saved.error) throw new Error("digest_delivery_confirmation_failed");
    return Response.json({ status: "sent", item_count: digest.items.length, external_message_id: externalMessageId });
  } catch (error) {
    const code = error instanceof Error ? error.message : "digest_send_failed";
    return Response.json({ error: code }, { status: code === "gmail_not_connected" ? 409 : 502 });
  }
}
