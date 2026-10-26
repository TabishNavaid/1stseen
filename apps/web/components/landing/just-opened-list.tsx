import Link from "next/link";
import { openedJustNow } from "@/components/brand/marks";
import { formatShortDay } from "@/lib/dates";
import type { RealOpening } from "@/lib/real-data";

/**
 * What opened in the last days, as a list rather than a strip that drifts past.
 *
 * One column, one row per opening, the full width of the content column: a date in a fixed left column so the dates
 * line up and the list reads down them, then the company, then the title. The rows are divided by a hairline and the
 * list has no border of its own. Nothing is clipped at a viewport edge, which is what a horizontal strip could not
 * promise — on a phone it cut a card in half at both ends and the second half of the list was off the screen.
 *
 * The date is the one ember on the page: this is the just-opened state, and nothing else wears that colour.
 */
export function JustOpenedList({ openings, now }: { openings: RealOpening[]; now: Date }) {
  return (
    <ul className="m-0 list-none p-0">
      {openings.map((opening) => (
        <li key={opening.id} className="relative grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 border-t border-line py-3 sm:grid-cols-[4.5rem_11rem_minmax(0,1fr)]">
          <span className="label-caps tabular font-mono text-warm-ink">{formatShortDay(opening.openedOn)}</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-ink-muted">{opening.company}</span>
            {openedJustNow(opening.openedOn, now) && <span className="hand shrink-0 text-base leading-none text-warm-ink" aria-hidden="true">new!</span>}
          </span>
          <span className="col-start-2 truncate text-sm font-semibold text-ink sm:col-start-3">
            <Link href={`/roles/${opening.roleId}`} className="focus-ring rounded-sm hover:underline after:absolute after:inset-0 after:content-['']">
              {opening.role}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}
