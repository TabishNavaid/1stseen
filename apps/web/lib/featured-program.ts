/**
 * Which program the landing page draws, by a stated rule rather than by hand.
 *
 * The hero chart claims that a program comes back around the same time each year, so the program that shows that
 * claim is the one to draw: enough years of its own openings to make a rhythm, and those openings landing close to
 * the same point of the year. No `server-only` import, so the rule can be read directly by its test.
 */

/** Three years of openings is the least that shows a rhythm rather than a pair of dots. */
export const FEATURED_YEARS = 3;

/** The circle the openings are measured on. A leap day's worth of drift does not change which program is tightest. */
export const DAYS_IN_YEAR = 365;

/** How many distinct years one program's openings cover, and how tightly they land on the same point of the year. */
export type OpeningRhythm = { years: number; spread: number };

/** A program with no recorded opening has no rhythm, and sorts behind every program that has one. */
export const NO_RHYTHM: OpeningRhythm = { years: 0, spread: DAYS_IN_YEAR };

/** Where a date sits in the year, in days, so openings in different years can be compared against each other. */
export function dayOfYear(iso: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return ((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / (leap ? 366 : 365)) * DAYS_IN_YEAR;
}

/**
 * How much of the year a program's openings are spread over, in days: the shortest stretch of the calendar that holds
 * all of them. Measured around the circle, the way `forecasting.py` models an annual date, so a program that opens in
 * late December one year and early January the next reads as tight rather than as eleven months apart. It is the
 * widest gap between neighbouring openings taken off the year, and one opening is spread over nothing.
 */
export function openingSpread(days: readonly number[]): number {
  if (days.length < 2) return 0;
  const sorted = [...days].sort((a, b) => a - b);
  let widestGap = sorted[0] + DAYS_IN_YEAR - sorted[sorted.length - 1];
  for (let index = 1; index < sorted.length; index += 1) widestGap = Math.max(widestGap, sorted[index] - sorted[index - 1]);
  return DAYS_IN_YEAR - widestGap;
}

/** One program's rhythm, from the days its openings are on record for. */
export function rhythmOf(openedOn: readonly string[]): OpeningRhythm {
  if (openedOn.length === 0) return NO_RHYTHM;
  return {
    years: new Set(openedOn.map((date) => date.slice(0, 4))).size,
    spread: openingSpread(openedOn.map(dayOfYear)),
  };
}

/** What the rule needs of a candidate: which program it is, and when its predicted window starts. */
export type FeaturedCandidate = { role_id: string; window_start: string | null };

/**
 * The featured program: of the candidates, the ones whose openings cover FEATURED_YEARS distinct years or more, and
 * of those the one whose openings land closest to the same point of the year, then the one whose window comes first.
 *
 * When nothing reaches FEATURED_YEARS no program can show a rhythm at all, and the most years wins instead, then the
 * soonest window: the fullest history is still the clearest thing to show. The program's own id breaks a remaining
 * tie, so the same corpus always draws the same program.
 */
export function featuredOf<T extends FeaturedCandidate>(rows: readonly T[], rhythms: Map<string, OpeningRhythm>): T | null {
  const rhythmOfRow = (row: T) => rhythms.get(row.role_id) ?? NO_RHYTHM;
  const soonest = (a: T, b: T) =>
    String(a.window_start ?? "").localeCompare(String(b.window_start ?? "")) || a.role_id.localeCompare(b.role_id);
  const enough = rows.filter((row) => rhythmOfRow(row).years >= FEATURED_YEARS);
  return enough.length > 0
    ? [...enough].sort((a, b) => rhythmOfRow(a).spread - rhythmOfRow(b).spread || soonest(a, b))[0]
    : [...rows].sort((a, b) => rhythmOfRow(b).years - rhythmOfRow(a).years || soonest(a, b))[0] ?? null;
}
