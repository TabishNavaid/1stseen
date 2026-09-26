import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { pageCount, pageNumbers, pageRangeLabel } from "@/lib/pagination";
import { cn } from "@/lib/utils";

/**
 * A pager: previous, the page numbers, next. `href` builds each one from the view it is in, so every link carries the
 * whole view with it — the tab, every filter and the sort — and only the page changes.
 *
 * A lone Next button said nothing about how far in a reader was or how much was left; "1–20 of 121" beside one arrow
 * is a fact and a guess. Numbers are the whole answer, and the current one is a word rather than a link, so there is
 * nothing to click that does not move.
 *
 * `scroll={false}` on every link: the router's own jump to the top of the document is what makes a reader lose the
 * list. The view moves itself to the head of the list instead, and puts focus there (components/forecast-dashboard).
 */
export function Pagination({
  page,
  size,
  shown,
  total,
  href,
  label = "Pages",
  className,
}: {
  page: number;
  size: number;
  /** How many rows this page actually drew. */
  shown: number;
  /** How many rows the whole list has, which is what the numbers are counted from. */
  total: number;
  href: (page: number) => string;
  label?: string;
  className?: string;
}) {
  const pages = pageCount(total, size);
  if (pages < 2) return null;
  const step = "focus-ring inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-chip px-3 text-sm font-semibold max-sm:min-h-touch";
  return (
    <nav aria-label={label} className={cn("mt-6 flex flex-col items-center gap-3 border-t border-line pt-5", className)}>
      <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-1 p-0">
        <li>
          {page > 1
            ? <Link href={href(page - 1)} scroll={false} rel="prev" className={cn(step, "text-ink hover:bg-surface-hover")}><Icon name="arrow-left" size={13} />Previous</Link>
            : <span aria-hidden="true" className={cn(step, "text-ink-subtle opacity-45")}><Icon name="arrow-left" size={13} />Previous</span>}
        </li>
        {pageNumbers(page, pages).map((mark, index) => (
          <li key={mark === "gap" ? `gap-${index}` : mark}>
            {mark === "gap"
              ? <span className="px-1 text-sm text-ink-subtle" aria-hidden="true">&hellip;</span>
              : mark === page
                ? <span aria-current="page" className={cn(step, "bg-accent text-ink-inverse")}>{mark}</span>
                : <Link href={href(mark)} scroll={false} aria-label={`Page ${mark}`} className={cn(step, "text-ink hover:bg-surface-hover")}>{mark}</Link>}
          </li>
        ))}
        <li>
          {page < pages
            ? <Link href={href(page + 1)} scroll={false} rel="next" className={cn(step, "text-ink hover:bg-surface-hover")}>Next<Icon name="arrow-right" size={13} /></Link>
            : <span aria-hidden="true" className={cn(step, "text-ink-subtle opacity-45")}>Next<Icon name="arrow-right" size={13} /></span>}
        </li>
      </ul>
      <p className="text-caption text-ink-subtle">{pageRangeLabel(page, size, shown, total)}</p>
    </nav>
  );
}
