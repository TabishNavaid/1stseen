import { locationLabel } from "@/lib/presentation";
import { Icon } from "@/components/ui/icon";
import type { ForecastRole } from "@firstseen/shared";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { evidenceSummary, roleMeta } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { cn } from "@/lib/utils";

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
      onClick={onSelect}
      className={cn(
        "group w-full border-b border-line px-4 py-4 text-left transition-colors md:px-5",
        active ? "bg-surface-selected" : "bg-surface hover:bg-surface-hover",
      )}
      aria-pressed={active}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(155px,.7fr)_112px_42px] sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-sunken text-xs font-bold text-accent-ink">{role.companyMark}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-ink-muted">{role.company}</p>{role.status === "signal" && <span className="flex items-center gap-1 text-micro font-semibold text-warning-ink"><Icon name="radio" size={11} />new signal</span>}</div>
            <h3 className="mt-1 line-clamp-2 text-sm font-semibold tracking-[-0.01em] text-ink" title={role.role}>{role.role}</h3>
            <p className="mt-1 text-caption text-ink-subtle">{item ? roleMeta(item) : `${role.track} · ${locationLabel(role.location)}`}</p>
          </div>
        </div>
        <div>
          <p className="flex items-center gap-1.5 label-caps text-ink-subtle"><Icon name="calendar-days" size={12} />Predicted window</p>
          <p className="mt-1.5 text-sm font-semibold tabular text-ink">{role.window}</p>
          <p className="mt-0.5 text-micro text-ink-subtle">{role.daysUntil} days to interval</p>
          {item && <p className="mt-0.5 text-micro text-ink-subtle">{item.historyCount} {item.historyCount === 1 ? "cycle" : "cycles"} behind it · {evidenceSummary(item).replace("Openings recorded: ", "")}</p>}
          {item?.basis && <p className="mt-1.5"><ForecastBasisChip basis={item.basis} variant="plain" /></p>}
        </div>
        <div><ConfidenceIndicator value={role.confidence} compact /></div>
        <Icon name="arrow-right" size={16} className="hidden text-ink-subtle transition-transform group-hover:translate-x-0.5 sm:block" />
      </div>
    </button>
  );
}
