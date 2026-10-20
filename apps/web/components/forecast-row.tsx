import Link from "next/link";
import { CompanyMark } from "@/components/brand/company-mark";
import { ConfidenceWord } from "@/components/confidence-word";
import { Icon } from "@/components/ui/icon";
import { windowRange } from "@/components/likely-window";
import { outlookNote, windowState } from "@/lib/forecast-window";
import { roleMeta } from "@/components/role-meta";
import { formatDay } from "@/lib/dates";
import { locationLabel } from "@/lib/presentation";
import type { DashboardListItem } from "@/lib/dashboard-query";
import type { ForecastRole } from "@firstseen/shared";
import { cn } from "@/lib/utils";

/**
 * One program in the list: the company's mark, who and what, the date it is likely to open, and the way to what that
 * date rests on.
 *
 * It is a row, not a card. Forty cards down a column, each with its own border, shadow and tinted ground, gave every
 * program the same weight and made the page look generated rather than set. A hairline between rows, a background
 * that shifts under the pointer, and one loud thing in each row do the same work with none of the boxes.
 *
 * The loud thing is the date, because it is the only fact on this page that nobody else has. Under it the window,
 * which a date is never shown without, and the confidence word on the same line rather than stacked beneath it: three
 * stacked lines in a narrow column is how the clutter comes back.
 *
 * The link to the program does not prefetch. A list renders one per row, and an RSC prefetch of a role page is a full
 * uncached server render -- `guest-cache.ts` refuses anything carrying `_rsc`, because an RSC payload is not a
 * document. Measured on 1stseen.win on 2026-10-20: a single visit to the list fired ten prefetches costing 13.5 s of
 * server work, the slowest 3.4 s, to make instant the one row a reader actually clicks. A cached document on that
 * same page answers in 77 ms, so the prefetching cost more than two orders of magnitude more than the page it was
 * trying to help. Every other list of programs does the same (`insufficient-role-row`, `recruiting-timeline`,
 * `forecast-change`, `recruiting-calendar`); a single deliberate link, like the drawer's, still prefetches.
 */
export function ForecastRow({
  role,
  item,
  today,
  active,
  onSelect,
}: {
  role: ForecastRole;
  /** The role's dashboard facts, when the row is listed on the dashboard. */
  item?: DashboardListItem;
  /** Today as `YYYY-MM-DD`, for which of its states the window is in (lib/forecast-window.ts). */
  today: string;
  active: boolean;
  onSelect: () => void;
}) {
  const outlook = item?.outlook ?? null;
  // The row carries no label over its date, so a window still ahead and one that has begun read the same here. The
  // one state it has to say is the last: the date has gone by and nothing has been seen open.
  const note = outlook ? outlookNote(windowState(outlook, today)) : null;
  return (
    <article
      className={cn(
        "grid items-center gap-x-5 gap-y-2 border-b border-line py-4 transition-colors",
        "grid-cols-[2.5rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(13rem,auto)_auto]",
        active ? "bg-surface-selected" : "hover:bg-surface-hover",
      )}
    >
      <CompanyMark company={role.company} className="row-span-2 self-start sm:row-span-1 sm:self-center" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-micro font-semibold uppercase tracking-label text-ink-subtle">
          {role.company}
          {role.status === "signal" && <span className="flex items-center gap-1 normal-case tracking-normal text-warning-ink"><Icon name="radio" size={11} />new signal</span>}
        </p>
        <h3 className="mt-1 line-clamp-2 text-base font-medium leading-snug text-ink sm:text-lg" title={role.role}>
          <Link href={`/roles/${role.id}`} prefetch={false} className="focus-ring rounded-sm hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{role.role}</Link>
        </h3>
        <p className="mt-1 truncate text-caption text-ink-subtle">{item ? roleMeta(item) : `${role.track} · ${locationLabel(role.location)}`}</p>
      </div>
      <div className="col-start-2 sm:col-start-3 sm:text-right">
        {/*
          The date is the loud line and the window is the quiet one under it, with the confidence word on that same
          line rather than a third one. The confidence belongs to the forecast, not to the window, so it is written
          whichever of the two a row has: a fixture carries only its window and still says how sure the model is.
        */}
        {outlook ? (
          <p className="heading-display tabular text-2xl leading-none text-ink underline decoration-date-predicted-line decoration-dashed decoration-2 underline-offset-[6px]">
            {formatDay(outlook.expected)}
          </p>
        ) : (
          <p className="tabular text-base font-semibold text-ink">{role.window}</p>
        )}
        <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption tabular text-ink-muted sm:justify-end">
          {note && <span className="font-semibold text-warm-ink">{note} ·</span>}
          {outlook && (note ? `window ${windowRange(outlook.start, outlook.end)}` : windowRange(outlook.start, outlook.end))}
          <ConfidenceWord value={role.confidence} align="end" variant="plain" />
        </p>
      </div>
      <div className="col-start-2 sm:col-start-4">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          className="focus-ring link-accent inline-flex min-h-touch items-center gap-1 rounded-sm text-caption font-semibold sm:min-h-9"
        >
          Why this date<Icon name="arrow-right" size={13} />
        </button>
      </div>
    </article>
  );
}
