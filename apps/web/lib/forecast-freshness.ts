import { formatDay } from "./dates.ts";

/**
 * How old a window is, in the two senses a reader cares about.
 *
 * A forecast is recomputed on a schedule whether or not anything about it changes, so the moment it was written moves
 * on its own. On its own that date says "this was worked out last night", which is true and answers the wrong
 * question: what a reader wants to know is when someone last looked, and when the answer last changed. Those are two
 * timestamps (`lastVerifiedAt` and `forecastedAt`, migration 202608140053) and this says both in one line.
 */

const DAY = 86_400_000;

/** Whole days between two instants, by calendar day rather than by elapsed hours. */
function daysBetween(from: string, to: Date): number {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / DAY);
}

/** "today", "yesterday", "3 days ago", or the date itself once "days ago" stops being a useful way to say it. */
export function checkedWhen(lastVerifiedAt: string, now: Date): string {
  const days = daysBetween(lastVerifiedAt, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 30) return `${days} days ago`;
  return `on ${formatDay(lastVerifiedAt)}`;
}

/**
 * The line under a window: when it was last checked, and when it last moved. Null when there is no forecast to
 * describe, so a caller renders nothing rather than a sentence about nothing.
 */
export function freshnessNote(forecast: { lastVerifiedAt: string; forecastedAt: string } | null, now: Date = new Date()): string | null {
  if (!forecast) return null;
  // A row written before the column existed carries the same value in both, and so does a window set at this check.
  const checked = checkedWhen(forecast.lastVerifiedAt, now);
  const settled = daysBetween(forecast.forecastedAt, now) === daysBetween(forecast.lastVerifiedAt, now);
  return settled
    ? `Checked ${checked}, which is when this window was set.`
    : `Checked ${checked}, unchanged since ${formatDay(forecast.forecastedAt)}.`;
}
