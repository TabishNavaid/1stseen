/**
 * The order of the Just opened feed: newest first, but no company takes more than two of any six consecutive items,
 * so one company posting a batch on one day cannot fill the page.
 *
 * Each place in the feed takes the newest remaining opening whose company has fewer than two of the five places before
 * it. When every remaining opening belongs to a company already at that limit (only one or two companies are left),
 * no ordering can keep the rule, so those openings are not placed: they are counted per company and the feed links to
 * each company's own list instead. A company's openings keep their newest-first order.
 *
 * Pure, so the tests read it directly.
 */

/** No company takes more than PER_WINDOW of any WINDOW consecutive items. */
export const WINDOW = 6;
export const PER_WINDOW = 2;

export type Overflow<Company> = { company: Company; count: number };

export function interleaveByCompany<T, Company>(
  newestFirst: readonly T[],
  companyOf: (item: T) => Company,
): { feed: T[]; overflow: Overflow<Company>[] } {
  const remaining = [...newestFirst];
  const feed: T[] = [];
  while (remaining.length) {
    const recent = feed.slice(-(WINDOW - 1)).map(companyOf);
    const index = remaining.findIndex((item) => {
      const company = companyOf(item);
      return recent.filter((placed) => placed === company).length < PER_WINDOW;
    });
    if (index === -1) break;
    feed.push(remaining.splice(index, 1)[0]);
  }
  const counts = new Map<Company, number>();
  for (const item of remaining) counts.set(companyOf(item), (counts.get(companyOf(item)) ?? 0) + 1);
  return { feed, overflow: [...counts].map(([company, count]) => ({ company, count })) };
}

/** Whether a sequence keeps the rule: used by the tests on real and generated feeds. */
export function keepsCompanyRule<T, Company>(items: readonly T[], companyOf: (item: T) => Company): boolean {
  for (let start = 0; start + 1 < items.length; start += 1) {
    const window = items.slice(start, start + WINDOW).map(companyOf);
    if (window.some((company) => window.filter((other) => other === company).length > PER_WINDOW)) return false;
  }
  return true;
}
