import Link from "next/link";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { PrecisionChip } from "@/components/precision-chip";
import { Icon } from "@/components/ui/icon";
import { formatDay } from "@/lib/dates";
import { noForecastReason } from "@/lib/forecast-gap";
import type { LandingPreview } from "@/lib/landing-data";

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

export function companyInitials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}

/**
 * The landing page's product preview: one real program, the openings recorded for it with where each was seen, and
 * its next predicted window. With no forecast behind two or more cycles yet, the same card shows a role's observed
 * history and says plainly why it has no window, rather than drawing one.
 */
export function RolePreviewCard({ preview }: { preview: LandingPreview }) {
  const { forecast } = preview;
  return (
    <article aria-labelledby="preview-role" className="card relative p-5 sm:p-6">
      <p className="flex items-center gap-2 text-caption font-semibold text-ink-subtle">
        <span className="size-2 rounded-full bg-success-line" aria-hidden="true" />
        A real program we track
      </p>
      <div className="mt-4 flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-control bg-warm-soft text-sm font-bold text-warm-ink" aria-hidden="true">{companyInitials(preview.company)}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-muted">{preview.company} <span className="font-normal text-ink-subtle">· {preview.programType}</span></p>
          <h2 id="preview-role" className="mt-0.5 text-lg font-semibold leading-snug tracking-title text-ink">
            <Link href={`/roles/${preview.roleId}`} className="focus-ring rounded-sm hover:underline">{preview.role}</Link>
          </h2>
        </div>
      </div>

      {preview.openings.length > 0 && (
        <div className="mt-5">
          <h3 className="label-caps text-ink-subtle">Opened before</h3>
          <ol className="mt-2 grid gap-2">
            {preview.openings.map((opening) => (
              <li key={opening.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control bg-surface-sunken px-3 py-2">
                <span className="text-sm font-semibold tabular text-ink">{formatDay(opening.openedOn)}</span>
                <PrecisionChip variant="plain" precision={opening.precision} />
                <a href={opening.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring ml-auto inline-flex min-h-touch items-center gap-1 text-caption sm:min-h-0">
                  {sourceHost(opening.sourceUrl)}{opening.archive ? " (archive)" : ""}<Icon name="arrow-up-right" size={11} />
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-5 border-t border-dashed border-line-strong pt-4">
        <h3 className="label-caps text-ink-subtle">Next window</h3>
        {forecast ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="inline-flex items-center rounded-control border border-dashed border-date-predicted-line bg-date-predicted-surface px-2.5 py-1 text-base font-semibold tabular text-date-predicted-ink">
                {formatDay(forecast.windowStart)} – {formatDay(forecast.windowEnd)}
              </p>
              <p className="mt-1.5 text-caption text-ink-muted">
                Expected {formatDay(forecast.expectedOpening)} · from {forecast.cycles} recruiting {forecast.cycles === 1 ? "cycle" : "cycles"}
              </p>
              {forecast.basis && <p className="mt-2"><ForecastBasisChip basis={forecast.basis} /></p>}
            </div>
            <ConfidenceIndicator value={forecast.confidence} compact />
          </div>
        ) : (
          <p className="mt-2 text-caption leading-5 text-ink-muted">
            No window yet. {noForecastReason(preview.openingsRecorded)}
          </p>
        )}
      </div>

      <Link href={`/roles/${preview.roleId}`} className="link-accent focus-ring mt-5 inline-flex min-h-touch items-center gap-1 text-sm">
        See this program<Icon name="arrow-right" size={14} />
      </Link>
    </article>
  );
}
