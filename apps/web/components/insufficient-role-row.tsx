import Link from "next/link";
import { CompanyMark } from "@/components/brand/company-mark";
import { Icon } from "@/components/ui/icon";
import { roleMeta } from "@/components/role-meta";
import type { DashboardListItem } from "@/lib/dashboard-query";
import { plainNoForecastReason } from "@/lib/forecast-gap";

/**
 * An in-scope role the model did not forecast, in the same row as the ones it did: listed and counted like every
 * other role, with the plain reason there is no window (`lib/forecast-gap`). Its role page lists the openings that
 * do exist.
 *
 * It keeps the forecast row's columns so the list stays one column of dates and one of names, with the reason
 * standing where a date would be rather than a gap where a reader expects one.
 */
export function InsufficientRoleRow({ item }: { item: DashboardListItem }) {
  return (
    <article className="grid items-center gap-x-5 gap-y-2 border-b border-line py-4 transition-colors grid-cols-[2.5rem_minmax(0,1fr)] hover:bg-surface-hover sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(13rem,auto)_auto]">
      <CompanyMark company={item.company} className="row-span-2 self-start sm:row-span-1 sm:self-center" />
      <div className="min-w-0">
        <p className="text-micro font-semibold uppercase tracking-label text-ink-subtle">{item.company}</p>
        <h3 className="mt-1 line-clamp-2 text-base font-medium leading-snug text-ink sm:text-lg">
          <Link href={`/roles/${item.id}`} className="focus-ring rounded-sm hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{item.role}</Link>
        </h3>
        <p className="mt-1 truncate text-caption text-ink-subtle">{roleMeta(item)}</p>
      </div>
      <div className="col-start-2 sm:col-start-3 sm:text-right">
        <p className="flex items-center gap-1.5 text-caption font-semibold text-ink-muted sm:justify-end"><Icon name="circle-dashed" size={12} />No date yet</p>
        <p className="mt-1.5 text-caption leading-5 text-ink-subtle">{plainNoForecastReason(item.exactEvents + item.boundedEvents + item.observedEvents)}</p>
      </div>
      <div className="col-start-2 sm:col-start-4" />
    </article>
  );
}
