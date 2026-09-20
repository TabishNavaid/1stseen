import Link from "next/link";
import { Bird } from "@/components/brand/bird";
import { CompanyMark } from "@/components/brand/company-mark";
import { ConfidenceWord } from "@/components/confidence-word";
import { OpeningTimeline } from "@/components/landing/opening-timeline";
import { formatDay } from "@/lib/dates";
import { Icon } from "@/components/ui/icon";
import { plainNoForecastReason } from "@/lib/forecast-gap";
import type { LandingPreview } from "@/lib/landing-data";

/**
 * The hero's card: one program 1stSeen follows, its openings drawn on a year (components/landing/opening-timeline.tsx),
 * and the window it is likely to open in next. A program without a forecast shows its openings and says plainly why it
 * has no date yet, rather than drawing one.
 */
export function RolePreviewCard({ preview }: { preview: LandingPreview }) {
  const { forecast } = preview;
  return (
    <article aria-labelledby="preview-role" className="card relative p-5 sm:p-6">
      {/*
        The bird looking out over the card, which is the whole product in one gesture: something is watching this
        program so the reader does not have to. It is decoration and is left out on a phone, where the card has to
        reach the fold on its own.
      */}
      <Bird pose="lookout" size="tucked" className="absolute -top-10 right-5 hidden sm:block bob-once" />
      <div className="flex items-start gap-3">
        <CompanyMark company={preview.company} />
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
        {forecast
          ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">Likely around {formatDay(forecast.expectedOpening)}</span>
              <ConfidenceWord value={forecast.confidence} />
            </span>
          )
          : <span />}
        <Link href={`/roles/${preview.roleId}`} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
          See this program<Icon name="arrow-right" size={14} />
        </Link>
      </div>
    </article>
  );
}
