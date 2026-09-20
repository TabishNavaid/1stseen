import { confidencePhrase } from "../confidence.ts";
import { basisPhrase, type ForecastBasis } from "../forecast-basis.ts";

// v2: an "opening soon" item states its forecast's basis, so its text, and so the fingerprint, differ from v1.
export const digestVersion = "deterministic-recruiting-digest-v2";

export type DigestKind =
  | "opening_soon"
  | "forecast_changed"
  | "role_opened"
  | "networking_deadline"
  | "referral_deadline"
  | "resume_deadline";

export type DigestItem = {
  itemKey: string;
  kind: DigestKind;
  canonicalRoleId: string;
  forecastId?: string;
  forecastChangeId?: string;
  historicalOpeningEventId?: string;
  readinessMilestoneId?: string;
  company: string;
  role: string;
  eventOn: string;
  headline: string;
  detail: string;
  href: string;
};

export type DigestSourceData = {
  asOf: string;
  periodStart: string;
  forecasts: Array<{ id: string; roleId: string; company: string; role: string; windowStart: string; windowEnd: string; confidence: number; basis?: ForecastBasis | null; href: string }>;
  /** Revisions a reader would feel, already filtered and described by lib/forecast-change-notes.ts. */
  changes: Array<{ id: string; forecastId: string; roleId: string; company: string; role: string; changedOn: string; notes: string[]; href: string }>;
  openings: Array<{ id: string; roleId: string; company: string; role: string; openedOn: string; href: string }>;
  milestones: Array<{ id: string; forecastId: string; roleId: string; company: string; role: string; kind: "networking" | "referral_contacts" | "resume_ready" | string; dueOn: string; href: string }>;
};

export type EmailDigest = {
  version: string;
  asOf: string;
  periodStart: string;
  periodEnd: string;
  subject: string;
  items: DigestItem[];
  fingerprint: string;
};

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}


async function sha256(value: string) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildEmailDigest(source: DigestSourceData): Promise<EmailDigest> {
  const soonEnd = addDays(source.asOf, 30);
  const deadlineEnd = addDays(source.asOf, 14);
  const items: DigestItem[] = [];
  for (const forecast of source.forecasts) {
    if (forecast.windowEnd < source.asOf || forecast.windowStart > soonEnd) continue;
    items.push({
      itemKey: `opening_soon:${forecast.id}`,
      kind: "opening_soon",
      canonicalRoleId: forecast.roleId,
      forecastId: forecast.id,
      company: forecast.company,
      role: forecast.role,
      eventOn: forecast.windowStart,
      headline: `${forecast.company} ${forecast.role} may open soon`,
      detail: `1stSeen forecast window ${forecast.windowStart} to ${forecast.windowEnd} · ${confidencePhrase(forecast.confidence)}${forecast.basis ? ` · ${basisPhrase(forecast.basis)}` : ""}. This is not a confirmed opening date.`,
      href: forecast.href,
    });
  }
  for (const change of source.changes) {
    items.push({
      itemKey: `forecast_changed:${change.id}`,
      kind: "forecast_changed",
      canonicalRoleId: change.roleId,
      forecastId: change.forecastId,
      forecastChangeId: change.id,
      company: change.company,
      role: change.role,
      eventOn: change.changedOn,
      headline: `${change.company} · ${change.role}`,
      detail: change.notes.join(" · "),
      href: change.href,
    });
  }
  for (const opening of source.openings) {
    items.push({
      itemKey: `role_opened:${opening.id}`,
      kind: "role_opened",
      canonicalRoleId: opening.roleId,
      historicalOpeningEventId: opening.id,
      company: opening.company,
      role: opening.role,
      eventOn: opening.openedOn,
      headline: `${opening.company} ${opening.role} opened`,
      detail: `A program you watch was posted on ${opening.openedOn}.`,
      href: opening.href,
    });
  }
  const milestoneKinds: Record<string, { kind: DigestKind; label: string }> = {
    networking: { kind: "networking_deadline", label: "Start networking" },
    referral_contacts: { kind: "referral_deadline", label: "Identify referral contacts" },
    resume_ready: { kind: "resume_deadline", label: "Resume-ready deadline" },
  };
  for (const milestone of source.milestones) {
    const mapped = milestoneKinds[milestone.kind];
    if (!mapped || milestone.dueOn < source.asOf || milestone.dueOn > deadlineEnd) continue;
    items.push({
      itemKey: `${mapped.kind}:${milestone.id}`,
      kind: mapped.kind,
      canonicalRoleId: milestone.roleId,
      forecastId: milestone.forecastId,
      readinessMilestoneId: milestone.id,
      company: milestone.company,
      role: milestone.role,
      eventOn: milestone.dueOn,
      headline: `${mapped.label} for ${milestone.company}`,
      detail: `${milestone.role} · due ${milestone.dueOn}.`,
      href: milestone.href,
    });
  }
  items.sort((a, b) => a.eventOn.localeCompare(b.eventOn) || a.kind.localeCompare(b.kind) || a.itemKey.localeCompare(b.itemKey));
  const periodEnd = soonEnd;
  const fingerprint = await sha256(JSON.stringify({ version: digestVersion, asOf: source.asOf, periodStart: source.periodStart, periodEnd, items }));
  return {
    version: digestVersion,
    asOf: source.asOf,
    periodStart: source.periodStart,
    periodEnd,
    subject: items.length ? `1stSeen recruiting digest · ${items.length} update${items.length === 1 ? "" : "s"}` : "1stSeen recruiting digest · No new actions",
    items,
    fingerprint,
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderDigestHtml(digest: EmailDigest) {
  const items = digest.items.length
    ? digest.items.map((item) => `<tr><td style="padding:18px 0;border-top:1px solid #dce1db"><div style="font-size:11px;color:#28705b;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(item.kind.replaceAll("_", " "))} · ${escapeHtml(item.eventOn)}</div><div style="font-size:16px;font-weight:700;color:#18221f;margin-top:5px">${escapeHtml(item.headline)}</div><div style="font-size:13px;line-height:1.6;color:#65716b;margin-top:5px">${escapeHtml(item.detail)}</div><a href="${escapeHtml(item.href)}" style="font-size:12px;color:#205847;font-weight:700">Open role intelligence →</a></td></tr>`).join("")
    : `<tr><td style="padding:24px 0;color:#65716b">No new watched-role actions or material changes were found for this period.</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f3f1eb;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:640px;background:#fffefa;border:1px solid #cbd2cb;padding:28px"><tr><td><div style="font-weight:800;color:#183f35">1stSeen</div><h1 style="font-size:24px;color:#18221f;margin:18px 0 6px">Recruiting intelligence digest</h1><p style="font-size:13px;line-height:1.6;color:#65716b;margin:0">Deterministic update from your watched roles as of ${escapeHtml(digest.asOf)}. Forecast dates are statistical predictions, not confirmed company dates.</p></td></tr>${items}<tr><td style="padding-top:20px;border-top:1px solid #dce1db;font-size:11px;line-height:1.5;color:#77827c">You explicitly requested this email from 1stSeen. Dates and events come from structured recruiting records; wording never creates new evidence.</td></tr></table></td></tr></table></body></html>`;
}
