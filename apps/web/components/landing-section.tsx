import Link from "next/link";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { Icon } from "@/components/ui/icon";
import { formatDay } from "@/lib/dates";
import type { LandingFeature } from "@/lib/landing-data";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { PrecisionChip } from "@/components/precision-chip";
import { PRECISION, PRECISION_ORDER } from "@/lib/precision";
import type { DatePrecision } from "@/lib/role-view";

/** What each class means, in the landing section's words. Its label and colour come from `lib/precision`. */
const PRECISION_MEANING: Record<DatePrecision, string> = {
  exact: "the job board's own publication date",
  bounded: "between two archive captures, absent then present",
  observed_by: "only seen in an archive by that date; it may have opened earlier",
};

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/**
 * The signed-out landing section, the product's front door, above the public dashboard on its default
 * view. In twenty seconds a stranger should see what 1stSeen predicts and why its evidence model matters, on a real
 * forecast: the headline and one sentence, then that forecast with the openings behind it and how each date is known,
 * then the principles, and a link to the methodology page, where the accuracy position lives with the latest backtest's own
 * numbers (the product-wide disclosure is said once, in the footer, and not repeated here).
 *
 * On a phone the forecast comes straight after the opening sentence; on a wide screen it sits beside the text.
 */
export function LandingSection({
  feature,
  inScopeRoles,
  forecastableRoles,
  companies,
}: {
  feature: LandingFeature;
  inScopeRoles: number;
  forecastableRoles: number;
  companies: number;
}) {
  const { forecast } = feature;

  return (
    <section aria-labelledby="landing-title" className="mb-6 grid border border-line bg-surface lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:grid-rows-[auto_1fr]">
      <div className="p-5 md:p-7 lg:pb-0">
        <p className="label-caps text-accent-ink">Early-career tech recruiting, forecast from evidence</p>
        <h1 id="landing-title" className="mt-3 max-w-2xl text-2xl font-semibold leading-tight tracking-title md:text-3xl">
          Know when an internship or new-grad program is likely to open, and exactly why.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">
          1stSeen forecasts each program&apos;s next opening from the openings it has actually seen on the job boards and archived career
          pages of {plural(companies, "company", "companies")}, and shows you every one of them.
        </p>
        <p className="mt-2 text-caption text-ink-subtle">
          {plural(inScopeRoles, "early-career technical role")} tracked · {forecastableRoles.toLocaleString("en-US")} with a forecast today
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/signin?mode=sign_up&return_to=%2Fwelcome" className="focus-ring inline-flex h-10 items-center gap-2 rounded-control bg-accent px-4 text-sm font-semibold text-ink-inverse hover:bg-accent-hover max-sm:h-touch">
            Create an account<Icon name="arrow-right" size={15} />
          </Link>
          <a href="#roles" className="focus-ring inline-flex h-10 items-center rounded-control border border-line-strong px-4 text-sm font-semibold text-ink hover:bg-surface-hover max-sm:h-touch">
            Browse all {inScopeRoles.toLocaleString("en-US")} roles
          </a>
        </div>
      </div>

      <div className="border-t border-line bg-surface-sunken p-5 md:p-7 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-t-0">
        <p className="label-caps text-ink-subtle">A real forecast from the corpus</p>
        {forecast ? (
          <div className="mt-2">
            <p className="text-caption text-ink-subtle">Chosen by rule: the highest confidence score among forecasts resting on two or more recruiting cycles</p>
            <p className="mt-3 text-sm font-semibold text-ink-muted">{forecast.company}</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-title">
              <Link href={`/roles/${forecast.roleId}`} className="focus-ring hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{forecast.role}</Link>
            </h2>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border border-line bg-surface p-4">
              <div>
                <p className="label-caps text-ink-subtle">Predicted opening window</p>
                <p className="mt-1 text-lg font-semibold tabular text-date-predicted-ink">{formatDay(forecast.windowStart)} – {formatDay(forecast.windowEnd)}</p>
                <p className="mt-1 text-caption text-ink-muted">
                  Expected {formatDay(forecast.expectedOpening)} · 80% prediction interval from {plural(forecast.cycles, "recruiting cycle")}
                </p>
                {forecast.basis && <p className="mt-2"><ForecastBasisChip basis={forecast.basis} /></p>}
              </div>
              <ConfidenceIndicator value={forecast.confidence} />
            </div>

            {forecast.sources.length > 0 ? (
              <>
                <h3 className="mt-5 label-caps text-ink-subtle">The openings behind it, and how each date is known</h3>
                <ul className="mt-2 divide-y divide-line border-y border-line">
                  {forecast.sources.map((cycle) => (
                    <li key={cycle.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2.5 text-caption">
                      <span className="font-semibold tabular text-ink">{formatDay(cycle.openedOn)}</span>
                      <PrecisionChip variant="plain" precision={cycle.precision} />
                      <span className="col-span-2 text-ink-muted">
                        {PRECISION_MEANING[cycle.precision]} ·{" "}
                        <a href={cycle.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring break-words">
                          {host(cycle.sourceUrl)}{cycle.archive ? " (archive)" : ""}
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Evidence behind it">
                {PRECISION_ORDER.map((precision) => (
                  <li key={precision}><PrecisionChip variant="plain" precision={precision}>{PRECISION[precision].label} {forecast.precisionCounts[precision]}</PrecisionChip></li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-micro text-ink-subtle">
              {forecast.modelVersion && forecast.forecastedAt ? <>Forecast by <span className="font-mono">{forecast.modelVersion}</span> on {formatDay(forecast.forecastedAt)}. </> : null}
              <Link href={`/roles/${forecast.roleId}`} className="link-accent focus-ring">See every source and the model inputs</Link>
            </p>
          </div>
        ) : (
          <p className="mt-3 text-caption leading-5 text-ink-muted">
            No forecast rests on two or more recruiting cycles yet. The roles below list every forecast and the evidence behind it.
          </p>
        )}
      </div>

      <div className="border-t border-line p-5 md:p-7 lg:border-t-0 lg:pt-6">
        <h2 className="label-caps text-ink-subtle">Why the evidence model matters</h2>
        <ol className="mt-3 grid gap-4 md:grid-cols-3 lg:grid-cols-1 2xl:grid-cols-3">
          <li className="border-t border-line pt-3">
            <p className="text-caption font-semibold text-ink"><span className="tabular text-ink-subtle">1.</span> Dates keep their precision</p>
            <p className="mt-1.5 flex flex-wrap gap-1.5"><PrecisionChip variant="plain" precision="exact" /><PrecisionChip variant="plain" precision="bounded" /><PrecisionChip variant="plain" precision="observed_by" /></p>
            <p className="mt-1.5 text-caption leading-5 text-ink-muted">A board&apos;s own publication time, a window between two archive captures, and a date something was merely seen by are stored apart and never promoted into one another.</p>
          </li>
          <li className="border-t border-line pt-3">
            <p className="text-caption font-semibold text-ink"><span className="tabular text-ink-subtle">2.</span> Numbers come from statistics</p>
            <p className="mt-1 text-caption leading-5 text-ink-muted">A fixed statistical model weighs past openings by their precision and produces the window and the confidence score. No language model produces a date, an interval, or a score.</p>
          </li>
          <li className="border-t border-line pt-3">
            <p className="text-caption font-semibold text-ink"><span className="tabular text-ink-subtle">3.</span> Replays refuse hindsight</p>
            <p className="mt-1 text-caption leading-5 text-ink-muted">A backtest may use only facts 1stSeen had recorded before its cutoff, so it never scores what it could not have known at the time.</p>
          </li>
        </ol>

        <p className="mt-5 text-caption">
          <Link href="/methodology#accuracy" className="link-accent focus-ring">How accuracy is measured, and where it stands</Link>
        </p>
      </div>
    </section>
  );
}
