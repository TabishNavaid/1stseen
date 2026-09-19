import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { roleMeta, evidenceSummary } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { noForecastReason } from "@/lib/forecast-gap";

function initials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}


/**
 * An in-scope role the model did not forecast. It is listed and counted like every other role, with the reason
 * there is no window (`lib/forecast-gap`) and the evidence that does exist.
 */
export function InsufficientRoleCard({ item }: { item: DashboardListItem }) {
  return (
    <article className="grid gap-3 border-b border-line bg-surface px-4 py-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(155px,.7fr)_154px] sm:items-center md:px-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-control border border-line bg-surface-sunken text-xs font-bold text-ink-muted">{initials(item.company)}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-muted">{item.company}</p>
          <h3 className="mt-1 line-clamp-2 text-sm font-semibold tracking-[-0.01em] text-ink">
            <Link href={`/roles/${item.id}`} className="focus-ring hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{item.role}</Link>
          </h3>
          <p className="mt-1 text-caption text-ink-subtle">{roleMeta(item)}</p>
        </div>
      </div>
      <div>
        <p className="label-caps flex items-center gap-1.5 text-ink-subtle"><Icon name="circle-dashed" size={12} />No forecast yet</p>
        <p className="mt-1.5 text-caption text-ink-muted">{noForecastReason(item.exactEvents + item.boundedEvents + item.observedEvents)}</p>
      </div>
      <p className="text-caption text-ink-subtle">{evidenceSummary(item)}</p>
    </article>
  );
}
