import { locationLabel } from "@/lib/presentation";
import { Icon } from "@/components/ui/icon";
import type { ForecastRole } from "@firstseen/shared";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { evidenceSummary, roleMeta } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { cn } from "@/lib/utils";

/**
 * A role with a forecast, as a card. The whole card opens the evidence drawer; the window reads as a prediction (dashed),
 * never as a confirmed date, and carries its basis and the cycles behind it.
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
    <button
      type="button"
      onClick={onSelect}
      className={cn("card lift focus-ring group w-full p-4 text-left sm:p-5", active && "border-accent bg-surface-selected")}
      aria-pressed={active}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(180px,.8fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-control bg-accent-soft text-xs font-bold text-accent-ink">{role.companyMark}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-ink-muted">{role.company}</p>{role.status === "signal" && <span className="flex items-center gap-1 text-micro font-semibold text-warning-ink"><Icon name="radio" size={11} />new signal</span>}</div>
            <h3 className="mt-0.5 line-clamp-2 text-base font-semibold leading-snug text-ink" title={role.role}>{role.role}</h3>
            <p className="mt-1 text-caption text-ink-subtle">{item ? roleMeta(item) : `${role.track} · ${locationLabel(role.location)}`}</p>
          </div>
        </div>
        {/* On a phone the window and the confidence share a row; from sm up they are the card's last two columns. */}
        <div className="flex items-start justify-between gap-3 sm:contents">
          <div>
            <p className="flex items-center gap-1.5 label-caps text-ink-subtle"><Icon name="calendar-days" size={12} />Predicted window</p>
            <p className="mt-1.5 inline-flex rounded-control border border-dashed border-date-predicted-line bg-date-predicted-surface px-2 py-0.5 text-sm font-semibold tabular text-date-predicted-ink">{role.window}</p>
            <p className="mt-1 text-micro text-ink-subtle">
              {role.daysUntil} days to interval{item ? ` · ${item.historyCount} ${item.historyCount === 1 ? "cycle" : "cycles"} behind it · ${evidenceSummary(item).replace("Openings recorded: ", "")}` : ""}
            </p>
            {item?.basis && <p className="mt-1.5"><ForecastBasisChip basis={item.basis} variant="plain" /></p>}
          </div>
          <div className="flex items-center gap-3 sm:justify-end">
            <ConfidenceIndicator value={role.confidence} compact />
            <span className="hidden size-9 place-items-center rounded-full bg-surface-sunken text-ink-subtle transition-colors group-hover:bg-accent group-hover:text-ink-inverse sm:grid" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>
          </div>
        </div>
      </div>
    </button>
  );
}
