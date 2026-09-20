import { confidencePhrase } from "../confidence.ts";
import { addDays } from "../dates.ts";

export const selectableCalendarEventTypes = [
  "networking",
  "referrals",
  "resume_ready",
  "portfolio_ready",
  "high_alert",
  "predicted_start",
  "predicted_end",
  "confirmed_opening",
  "confirmed_closing",
] as const;

export type SelectableCalendarEventType = (typeof selectableCalendarEventTypes)[number];

export type SelectedCalendarEvent = {
  sourceKey: string;
  eventType: SelectableCalendarEventType;
  date: string;
  endDate?: string;
  company: string;
  role: string;
  label: string;
  detail: string;
  confidence?: number;
  roleUrl: string;
};

export type GoogleEvent = {
  id: string;
  summary: string;
  description: string;
  start: { date: string };
  end: { date: string };
  transparency: "transparent";
  extendedProperties: { private: { firstseenSourceKey: string; firstseenSemantics: string } };
};

export type ExistingSync = {
  googleEventId: string;
  fingerprint: string;
};

export type SyncOperations = {
  find(sourceKey: string, sourceKind: string): Promise<ExistingSync | null>;
  insert(event: GoogleEvent): Promise<void>;
  update(eventId: string, event: GoogleEvent): Promise<void>;
  save(mapping: ExistingSync & { sourceKey: string; sourceKind: string }): Promise<void>;
};

export function sourceKindFor(type: SelectableCalendarEventType) {
  if (type === "predicted_start" || type === "predicted_end") return "forecast_window";
  if (type === "confirmed_opening") return "confirmed_opening";
  if (type === "confirmed_closing") return "confirmed_closing";
  return "readiness_milestone";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deterministicGoogleEventId(userId: string, sourceKind: string, sourceKey: string) {
  return `1stseen${(await sha256(`${userId}|${sourceKind}|${sourceKey}`)).slice(0, 48)}`;
}

export async function mapSelectedEvent(input: SelectedCalendarEvent, userId: string): Promise<GoogleEvent> {
  const sourceKind = sourceKindFor(input.eventType);
  const predicted = sourceKind === "forecast_window";
  const confirmed = sourceKind === "confirmed_opening" || sourceKind === "confirmed_closing";
  const semantics = predicted ? "forecast" : confirmed ? "confirmed" : "readiness";
  const prefix = predicted ? "1stSeen forecast" : confirmed ? "Confirmed" : "1stSeen";
  const forecastNotice = predicted
    ? "This is a 1stSeen statistical forecast, not a confirmed company date. Forecasts can change as new evidence arrives."
    : confirmed
      ? "This date was recorded from confirmed recruiting evidence in 1stSeen."
      : "You chose this prep step in 1stSeen.";
  const confidence = predicted && input.confidence !== undefined
    ? `\nForecast ${confidencePhrase(input.confidence)}: how much consistent evidence backs the window, not the chance it is right.`
    : "";
  return {
    id: await deterministicGoogleEventId(userId, sourceKind, input.sourceKey),
    summary: `${prefix}: ${input.label} — ${input.company} ${input.role}`,
    description: `${forecastNotice}${confidence}\n\n${input.detail}\n\nRole intelligence: ${input.roleUrl}`,
    start: { date: input.date },
    end: { date: input.endDate ? addDays(input.endDate, 1) : addDays(input.date, 1) },
    transparency: "transparent",
    extendedProperties: {
      private: { firstseenSourceKey: input.sourceKey, firstseenSemantics: semantics },
    },
  };
}

export async function fingerprintGoogleEvent(event: GoogleEvent) {
  return sha256(JSON.stringify(event));
}

export async function syncSelectedEvent(
  input: SelectedCalendarEvent,
  userId: string,
  operations: SyncOperations,
) {
  const sourceKind = sourceKindFor(input.eventType);
  const event = await mapSelectedEvent(input, userId);
  const fingerprint = await fingerprintGoogleEvent(event);
  const existing = await operations.find(input.sourceKey, sourceKind);
  if (existing?.fingerprint === fingerprint) {
    return { action: "unchanged" as const, googleEventId: existing.googleEventId, fingerprint };
  }
  if (existing) {
    await operations.update(existing.googleEventId, { ...event, id: existing.googleEventId });
    await operations.save({ sourceKey: input.sourceKey, sourceKind, googleEventId: existing.googleEventId, fingerprint });
    return { action: "updated" as const, googleEventId: existing.googleEventId, fingerprint };
  }
  await operations.insert(event);
  await operations.save({ sourceKey: input.sourceKey, sourceKind, googleEventId: event.id, fingerprint });
  return { action: "created" as const, googleEventId: event.id, fingerprint };
}
