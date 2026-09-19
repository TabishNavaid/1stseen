import Link from "next/link";
import { ConfidenceWord } from "@/components/confidence-word";
import { companyInitials } from "@/components/landing/role-preview-card";
import { LikelyWindow } from "@/components/likely-window";
import type { OpeningSoonRole } from "@/lib/landing-data";

/**
 * One upcoming window. The title's link covers the whole card, so the card is one click target and lifts on hover,
 * while the confidence word above it stays its own control for its explanation.
 */
export function OpeningSoonCard({ role }: { role: OpeningSoonRole }) {
  const { forecast } = role;
  return (
    <li className="card lift relative flex h-full flex-col p-5">
      <span className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-control bg-accent-soft text-xs font-bold text-accent-ink" aria-hidden="true">{companyInitials(role.company)}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-ink-muted">{role.company}</span>
          <span className="block text-caption text-ink-subtle">{role.programType}</span>
        </span>
      </span>
      <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-snug text-ink">
        <Link href={`/roles/${role.roleId}`} className="focus-ring rounded-sm after:absolute after:inset-0 after:rounded-card after:content-['']">{role.role}</Link>
      </h3>
      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-5">
        <LikelyWindow outlook={{ expected: forecast.expectedOpening, start: forecast.windowStart, end: forecast.windowEnd }} />
        <span className="relative z-10"><ConfidenceWord value={forecast.confidence} align="end" /></span>
      </div>
    </li>
  );
}
