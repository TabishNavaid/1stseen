import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { roleMeta } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { plainNoForecastReason } from "@/lib/forecast-gap";

function initials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}

/**
 * An in-scope role the model did not forecast. It is listed and counted like every other role, with the plain reason
 * there is no window (`lib/forecast-gap`); its role page lists the openings that do exist.
 */
export function InsufficientRoleCard({ item }: { item: DashboardListItem }) {
  return (
    <article className="card grid gap-3 p-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(190px,1fr)] sm:items-center sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-control bg-surface-sunken text-xs font-bold text-ink-muted">{initials(item.company)}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-muted">{item.company}</p>
          <h3 className="mt-0.5 line-clamp-2 text-base font-semibold leading-snug text-ink">
            <Link href={`/roles/${item.id}`} className="focus-ring rounded-sm hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{item.role}</Link>
          </h3>
          <p className="mt-1 text-caption text-ink-subtle">{roleMeta(item)}</p>
        </div>
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-caption font-semibold text-ink-muted"><Icon name="circle-dashed" size={12} />No date yet</p>
        <p className="mt-1.5 text-caption leading-5 text-ink-muted">{plainNoForecastReason(item.exactEvents + item.boundedEvents + item.observedEvents)}</p>
      </div>
    </article>
  );
}
