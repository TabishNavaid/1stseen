import Link from "next/link";
import { ConfidenceWord } from "@/components/confidence-word";
import { LikelyWindow } from "@/components/likely-window";
import { Icon } from "@/components/ui/icon";
import { formatDay } from "@/lib/dates";
import { plainNoForecastReason } from "@/lib/forecast-gap";
import type { LandingOpening, LandingPreview } from "@/lib/landing-data";

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
 * A past opening in words that keep what is known apart without naming evidence classes: a date the board published
 * ("Opened"), a range between two archive captures ("Opened between"), or a date it was only seen by ("Seen open by").
 */
export function openingWords(opening: Pick<LandingOpening, "precision" | "openedOn" | "windowStart">): string {
  if (opening.precision === "observed_by") return `Seen open by ${formatDay(opening.openedOn)}`;
  if (opening.precision === "bounded") {
    return opening.windowStart ? `Opened between ${formatDay(opening.windowStart)} and ${formatDay(opening.openedOn)}` : `Opened by ${formatDay(opening.openedOn)}`;
  }
  return `Opened ${formatDay(opening.openedOn)}`;
}

/**
 * The landing page's product preview: one real program, when it opened before with where each date was seen, and when it
 * is likely to open next. With no forecast behind two or more cycles yet, the same card shows a role's history and
 * says plainly why it has no date yet, rather than drawing one.
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

      {forecast ? (
        <div className="mt-5 flex flex-wrap items-end justify-between gap-4 rounded-card bg-surface-sunken p-4">
          <LikelyWindow outlook={{ expected: forecast.expectedOpening, start: forecast.windowStart, end: forecast.windowEnd }} size="lg" />
          <ConfidenceWord value={forecast.confidence} align="end" />
        </div>
      ) : (
        <p className="mt-5 rounded-card bg-surface-sunken p-4 text-caption leading-5 text-ink-muted">No date yet. {plainNoForecastReason(preview.openingsRecorded)}</p>
      )}

      {preview.openings.length > 0 && (
        <div className="mt-5">
          <h3 className="label-caps text-ink-subtle">Before</h3>
          <ol className="mt-2 grid gap-1.5">
            {preview.openings.map((opening) => (
              <li key={opening.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="font-semibold tabular text-ink">{openingWords(opening)}</span>
                <a href={opening.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring ml-auto inline-flex min-h-touch items-center gap-1 text-caption sm:min-h-0">
                  {sourceHost(opening.sourceUrl)}{opening.archive ? " (archive)" : ""}<Icon name="arrow-up-right" size={11} />
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      <Link href={`/roles/${preview.roleId}`} className="link-accent focus-ring mt-5 inline-flex min-h-touch items-center gap-1 text-sm">
        See this program<Icon name="arrow-right" size={14} />
      </Link>
    </article>
  );
}
