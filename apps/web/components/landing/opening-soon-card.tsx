import Link from "next/link";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { companyInitials } from "@/components/landing/role-preview-card";
import { formatDay, formatShortDay } from "@/lib/dates";
import type { OpeningSoonRole } from "@/lib/landing-data";

/** One upcoming window: the whole card is the link to its role page, and lifts on hover. */
export function OpeningSoonCard({ role }: { role: OpeningSoonRole }) {
  const { forecast } = role;
  return (
    <li className="h-full">
      <Link href={`/roles/${role.roleId}`} className="card lift focus-ring flex h-full flex-col p-5">
        <span className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-control bg-accent-soft text-xs font-bold text-accent-ink" aria-hidden="true">{companyInitials(role.company)}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink-muted">{role.company}</span>
            <span className="block text-caption text-ink-subtle">{role.programType}</span>
          </span>
        </span>
        <span className="mt-3 line-clamp-2 text-base font-semibold leading-snug text-ink">{role.role}</span>
        <span className="mt-auto flex items-end justify-between gap-3 pt-5">
          <span>
            <span className="block label-caps text-ink-subtle">Predicted window</span>
            <span className="mt-1 inline-flex rounded-control border border-dashed border-date-predicted-line bg-date-predicted-surface px-2 py-0.5 text-sm font-semibold tabular text-date-predicted-ink">
              {formatShortDay(forecast.windowStart)} – {formatDay(forecast.windowEnd)}
            </span>
            {forecast.basis && <span className="mt-2 block"><ForecastBasisChip basis={forecast.basis} variant="plain" /></span>}
          </span>
          <ConfidenceIndicator value={forecast.confidence} compact />
        </span>
      </Link>
    </li>
  );
}
