/**
 * UTC date formatting shared by every surface.
 *
 * Recruiting dates are calendar days, not instants. Parsing a bare `YYYY-MM-DD`
 * with `new Date()` yields UTC midnight, which renders as the *previous* day for
 * anyone west of Greenwich, so bare dates are anchored at midday UTC and every
 * formatter is pinned to UTC. A forecast window must read identically wherever
 * it is viewed.
 *
 * `Intl.DateTimeFormat` construction is the expensive part of formatting, so the
 * formatters are built once at module scope rather than per call inside render
 * loops that run over hundreds of roles and calendar events.
 */

/** Anchor a bare `YYYY-MM-DD` at midday UTC; pass full ISO timestamps through. */
export function utcDate(value: string): Date {
  return new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const shortDayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const stampFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});

/** `Sep 11, 2025` */
export function formatDay(value: string): string {
  return dayFormatter.format(utcDate(value));
}

/** `Sep 11` */
export function formatShortDay(value: string): string {
  return shortDayFormatter.format(utcDate(value));
}

/** `Sep 11, 2025, 08:00 UTC` — for observation and forecast timestamps. */
export function formatStamp(value: string): string {
  return `${stampFormatter.format(utcDate(value))} UTC`;
}

const customFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Format with an arbitrary option set, reusing the formatter for that set.
 * Used by the calendar, which needs weekday and long-month variants.
 */
export function formatDateWith(value: string, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let formatter = customFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
    customFormatters.set(key, formatter);
  }
  return formatter.format(utcDate(value));
}

/** Shift a `YYYY-MM-DD` day by whole days, returning the same format. */
export function addDays(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
