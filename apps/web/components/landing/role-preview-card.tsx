import Link from "next/link";
import { ConfidenceWord } from "@/components/confidence-word";
import { OpeningTimeline } from "@/components/landing/opening-timeline";
import { Icon } from "@/components/ui/icon";
import { plainNoForecastReason } from "@/lib/forecast-gap";
import type { LandingPreview } from "@/lib/landing-data";

export function companyInitials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}

/**
 * The hero's card: one program 1stSeen follows, its openings drawn on a year (components/landing/opening-timeline.tsx),
 * and the window it is likely to open in next. A program without a forecast shows its openings and says plainly why it
 * has no date yet, rather than drawing one.
 */
export function RolePreviewCard({ preview }: { preview: LandingPreview }) {
  const { forecast } = preview;
  return (
    <article aria-labelledby="preview-role" className="card relative overflow-hidden p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-control bg-warm-soft text-sm font-bold text-warm-ink" aria-hidden="true">{companyInitials(preview.company)}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-muted">{preview.company} <span className="font-normal text-ink-subtle">· {preview.programType}</span></p>
          <h2 id="preview-role" className="mt-0.5 text-lg font-semibold leading-snug tracking-title text-ink">
            <Link href={`/roles/${preview.roleId}`} className="focus-ring rounded-sm hover:underline">{preview.role}</Link>
          </h2>
        </div>
      </div>

      <div className="mt-5">
        <OpeningTimeline openings={preview.openings} forecast={forecast} />
      </div>

      {!forecast && (
        <p className="mt-4 rounded-card bg-surface-sunken p-3 text-caption leading-5 text-ink-muted">No date yet. {plainNoForecastReason(preview.openingsRecorded)}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {forecast ? <ConfidenceWord value={forecast.confidence} /> : <span />}
        <Link href={`/roles/${preview.roleId}`} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
          See this program<Icon name="arrow-right" size={14} />
        </Link>
      </div>
    </article>
  );
}
