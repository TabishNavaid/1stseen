import Link from "next/link";
import { locationLabel } from "@/lib/presentation";
import { Icon } from "@/components/ui/icon";
import type { ForecastRole } from "@firstseen/shared";
import { ConfidenceWord } from "@/components/confidence-word";
import { LikelyWindow } from "@/components/likely-window";
import { roleMeta } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { cn } from "@/lib/utils";

/**
 * A role with a forecast, as a card: who and what, then "Likely around" the expected opening with its window, one
 * confidence word, and "Why this date", which opens the evidence drawer. The numbers behind the date (its basis, the
 * cycles, the score) are one step away there and on the role page, not on the card.
 */
export function ForecastCard({
  role,
  item,
  active,
  onSelect,
}: {
  role: ForecastRole;
  /** The role's dashboard facts, when the card is listed on the dashboard. */
  item?: DashboardListItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={cn("card p-4 transition-colors sm:p-5", active && "border-accent bg-surface-selected")}>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(190px,.8fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-control bg-accent-soft text-xs font-bold text-accent-ink" aria-hidden="true">{role.companyMark}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-ink-muted">{role.company}</p>{role.status === "signal" && <span className="flex items-center gap-1 text-micro font-semibold text-warning-ink"><Icon name="radio" size={11} />new signal</span>}</div>
            <h3 className="mt-0.5 line-clamp-2 text-base font-semibold leading-snug text-ink" title={role.role}>
              <Link href={`/roles/${role.id}`} className="focus-ring rounded-sm hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{role.role}</Link>
            </h3>
            <p className="mt-1 text-caption text-ink-subtle">{item ? roleMeta(item) : `${role.track} · ${locationLabel(role.location)}`}</p>
          </div>
        </div>
        <LikelyWindow outlook={item?.outlook ?? null} window={role.window} />
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          <ConfidenceWord value={role.confidence} align="end" />
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={active}
            className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-chip px-3 text-xs font-semibold text-accent-ink hover:bg-surface-hover max-sm:min-h-touch"
          >
            Why this date<Icon name="arrow-right" size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
