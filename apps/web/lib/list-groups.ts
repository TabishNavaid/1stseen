import type { DashboardListItem, DashboardSort } from "./dashboard-query.ts";

/**
 * The list, cut into the months its programs are likely to open in.
 *
 * A column of forty rows all set the same way is a column a reader scrolls past. Month headings over a list already
 * in date order give the page a rhythm and make the date column mean something at a glance.
 *
 * They are months rather than "the next 30 days" because that is what this corpus is: measured on 2026-09-26, the
 * middle of it opens about nine months out and only thirteen of five hundred and seventy-seven windows start inside
 * ninety days. Bands of "soon, quite soon, later" would have put ninety-seven per cent of the list under one heading,
 * which is a heading that says nothing.
 *
 * Only when the list is in date order. Sorted by confidence or by company, a month heading would lie about the rows
 * under it, so the list is left as one run.
 */

export type RoleBand = { key: string; title: string; items: DashboardListItem[] };

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** The band a row belongs to: the month its window is likely to open in, or one of the two ends. */
export function bandFor(item: DashboardListItem, now: Date): { key: string; title: string } {
  if (!item.outlook) return { key: "undated", title: "No date yet" };
  const open = Date.parse(`${item.outlook.start.slice(0, 10)}T00:00:00Z`) <= Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (open) return { key: "open", title: "Open now, or its window has started" };
  const month = `${item.outlook.expected.slice(0, 7)}`;
  return { key: month, title: MONTH.format(new Date(`${month}-01T00:00:00Z`)) };
}

/** The bands in the list's own order, each with the rows that fall in it. A band is never a heading over nothing. */
export function bandRoles(items: readonly DashboardListItem[], sort: DashboardSort, now: Date = new Date()): RoleBand[] {
  if (sort !== "window" || items.length === 0) return [{ key: "all", title: "", items: [...items] }];
  const bands: RoleBand[] = [];
  for (const item of items) {
    const band = bandFor(item, now);
    const last = bands[bands.length - 1];
    if (last && last.key === band.key) last.items.push(item);
    else bands.push({ ...band, items: [item] });
  }
  return bands;
}
