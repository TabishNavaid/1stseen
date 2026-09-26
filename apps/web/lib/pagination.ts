/**
 * Which page numbers a pager draws.
 *
 * A list of 121 programs is seven pages; a list of 4,000 is two hundred, and no one wants two hundred links. The
 * first page, the last page, and the pages either side of the one being read are always there, and what is skipped
 * between them is a gap rather than a link, so the row stays the same width however long the list is.
 *
 * Kept free of React so the tests read it directly.
 */

export type PageMark = number | "gap";

/** How many pages a list of `count` rows is, at `size` rows a page. Never fewer than one: an empty list is page 1. */
export function pageCount(count: number, size: number): number {
  return Math.max(1, Math.ceil(count / size));
}

/**
 * The marks a pager draws for `current` of `total`, with `around` pages either side of the current one. A gap stands
 * for two or more skipped pages; a single skipped page is drawn as itself, because a gap hiding one number is worse
 * than the number.
 */
export function pageNumbers(current: number, total: number, around = 1): PageMark[] {
  const page = Math.min(Math.max(Math.round(current), 1), Math.max(total, 1));
  // Up to seven fit in the row a gap would take anyway, so a short list is drawn whole and nothing is hidden.
  if (total <= 7) return Array.from({ length: Math.max(total, 1) }, (_, index) => index + 1);
  const shown = new Set<number>([1, total]);
  for (let offset = -around; offset <= around; offset += 1) {
    const candidate = page + offset;
    if (candidate >= 1 && candidate <= total) shown.add(candidate);
  }
  const marks: PageMark[] = [];
  let previous = 0;
  for (const value of [...shown].sort((a, b) => a - b)) {
    if (previous > 0 && value - previous === 2) marks.push(previous + 1);
    else if (previous > 0 && value - previous > 2) marks.push("gap");
    marks.push(value);
    previous = value;
  }
  return marks;
}

/** The words under a pager: which rows of how many this page is. */
export function pageRangeLabel(page: number, size: number, shown: number, total: number): string {
  if (shown === 0) return "No programs on this page";
  const first = (page - 1) * size + 1;
  const last = first + shown - 1;
  const count = total.toLocaleString("en-US");
  return `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${count}`;
}
