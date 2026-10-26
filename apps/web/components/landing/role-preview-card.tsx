import Link from "next/link";
import { Bird } from "@/components/brand/bird";
import { CompanyMark } from "@/components/brand/company-mark";
import { ConfidenceMeter } from "@/components/confidence-meter";
import { LikelyWindow } from "@/components/likely-window";
import { OpeningTimeline } from "@/components/landing/opening-timeline";
import { Icon } from "@/components/ui/icon";
import { plainNoForecastReason } from "@/lib/forecast-gap";
import type { LandingPreview } from "@/lib/landing-data";

/**
 * The hero's card: one program 1stSeen follows, its openings drawn on a year (components/landing/opening-timeline.tsx),
 * and the window it is likely to open in next. A program without a forecast shows its openings and says plainly why it
 * has no date yet, rather than drawing one.
 *
 * It reads as three beats, in this order: the record of when it opened before, the window that sits under those
 * openings, and then the date itself. The date is the last beat and the loudest thing on the card, because it is what
 * the record is for — it used to sit in the footer at the size of a caption, which made the card a tasteful chart
 * whose point was a footnote.
 */
export function RolePreviewCard({ preview, today }: { preview: LandingPreview; today: string }) {
  const { forecast } = preview;
  return (
    <article aria-labelledby="preview-role" className="card relative p-6">
      {/*
        The bird perched on the corner of the card, which is the whole product in one gesture: something is watching
        this program so the reader does not have to. It is decoration and is left out on a phone, where the card has
        to reach the fold on its own.
      */}
      <Bird pose="lookout" size="perch" className="bob-once absolute -top-10 right-5 hidden sm:block" />
      <div className="flex items-start gap-3">
        <CompanyMark company={preview.company} priority />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-muted">{preview.company} <span className="font-normal text-ink-subtle">· {preview.programType}</span></p>
          <h2 id="preview-role" className="mt-1 text-lg font-semibold leading-snug tracking-title text-ink">
            <Link href={`/roles/${preview.roleId}`} className="focus-ring rounded-sm hover:underline">{preview.role}</Link>
          </h2>
        </div>
      </div>

      <div className="mt-6" data-beat="record">
        <OpeningTimeline openings={preview.openings} forecast={forecast} />
      </div>

      {!forecast && (
        <p className="mt-4 rounded-card bg-surface-sunken p-3 text-caption leading-5 text-ink-muted">No date yet. {plainNoForecastReason(preview.openingsRecorded)}</p>
      )}

      {forecast && (
        <div className="mt-6 border-t border-line pt-6" data-beat="date">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
            <LikelyWindow
              outlook={{ expected: forecast.expectedOpening, start: forecast.windowStart, end: forecast.windowEnd }}
              today={today}
              size="lg"
            />
            <ConfidenceMeter value={forecast.confidence} />
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Link href={`/roles/${preview.roleId}`} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
          See this program<Icon name="arrow-right" size={14} />
        </Link>
      </div>
    </article>
  );
}
