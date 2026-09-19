import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { PROVENANCE_PAGE_SIZE } from "@/lib/role-view";
import type { DatePrecision, RoleView } from "@/lib/role-view";
import { AgentInvestigation } from "@/components/agent-investigation";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { FollowButton } from "@/components/follow-button";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { PrecisionChip } from "@/components/precision-chip";
import { GenerateReadinessButton } from "@/components/generate-readiness-button";
import { SourceBadge } from "@/components/source-badge";
import { Badge } from "@/components/ui/badge";
import { WorkspaceHeader } from "@/components/workspace-header";
import { confidenceOutOf, formatConfidence } from "@/lib/confidence";
import { formatDay, formatStamp } from "@/lib/dates";
import { BASIS } from "@/lib/forecast-basis";
import { PRECISION_ORDER } from "@/lib/precision";
import { PLAN_OUTCOME_MESSAGES, type PlanOutcome } from "@/lib/onboarding";
import { contributionLabel, humanize, locationLabel } from "@/lib/presentation";

/**
 * Evidence precision must never blur. `exact` requires a source-supplied publication timestamp, `bounded` requires an
 * absence→presence transition, and `observed_by` means only that the role was visible by that date. Each class has its
 * own semantic utility (a border style as well as colors) and always carries its label.
 */
/** What each class means, in this page's words. The label, colour and icon come from `lib/precision`. */
const precisionMeaning: Record<DatePrecision, string> = {
  exact: "The source supplied this publication date.",
  bounded: "A complete earlier capture proved absence and a later one proved presence.",
  observed_by: "The role was visible by this date. It may have opened earlier.",
};

const milestoneLabels: Record<string, string> = {
  networking: "Start networking",
  referral_contacts: "Identify referral contacts",
  resume_ready: "Resume ready",
  portfolio_ready: "Portfolio ready",
  high_alert: "High-alert monitoring",
};

const factorTone = { positive: "text-success-ink", warning: "text-warning-ink", neutral: "text-ink" } as const;

function day(value: string | null): string {
  return value ? formatDay(value) : "—";
}

function stamp(value: string | null): string {
  return value ? formatStamp(value) : "—";
}

function Section({ id, eyebrow, title, note, children }: {
  id?: string; eyebrow: string; title: string; note?: string; children: React.ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className="panel scroll-mt-32" aria-labelledby={headingId} aria-label={headingId ? undefined : title}>
      <div className="border-b border-line px-4 py-3 md:px-5">
        <p className="label-caps text-ink-subtle">{eyebrow}</p>
        <h2 id={headingId} className="mt-1 text-base font-semibold">{title}</h2>
        {note && <p className="mt-1 text-caption text-ink-subtle">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function WindowVisualization({ view }: { view: RoleView }) {
  const forecast = view.forecast!;
  return (
    <figure
      className="border border-line bg-surface-sunken p-4"
      aria-label={`Predicted opening window ${day(forecast.windowStart)} to ${day(forecast.windowEnd)}, expected ${day(forecast.expectedOpening)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-caps text-ink-subtle">Prediction interval</span>
        <span className="text-micro tabular text-ink-subtle">
          {forecast.daysUntilWindow >= 0 ? `${forecast.daysUntilWindow} days until it starts` : "The interval has started"}
        </span>
      </div>
      <div className="relative mt-8 h-10" aria-hidden="true">
        <div className="absolute inset-x-0 top-3 h-px bg-line-strong" />
        <div className="absolute left-[14%] top-[7px] h-3 w-[72%] rounded-full border border-dashed border-date-predicted-line bg-date-predicted-surface" />
        <div className="absolute left-1/2 top-0 h-7 w-px bg-accent">
          <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-micro font-semibold text-accent-ink">
            expected {day(forecast.expectedOpening)}
          </span>
        </div>
        <span className="absolute left-0 top-6 whitespace-nowrap text-micro font-medium tabular text-ink-muted">{day(forecast.windowStart)}</span>
        <span className="absolute right-0 top-6 whitespace-nowrap text-micro font-medium tabular text-ink-muted">{day(forecast.windowEnd)}</span>
      </div>
      <figcaption className="mt-4 flex gap-2 text-micro text-ink-subtle">
        <Icon name="info" size={12} className="mt-0.5" />
        <span>80% prediction interval, computed by <span className="font-mono">{forecast.modelVersion}</span>.</span>
      </figcaption>
    </figure>
  );
}

/** The model refused this role (`lib/forecast-gap`): a plain statement about its history, beside the openings that exist. */
function InsufficientEvidence({ view }: { view: RoleView }) {
  return (
    <section id="forecast" className="panel scroll-mt-32" aria-labelledby="forecast-title">
      <div className="border-b border-line px-4 py-3 md:px-5">
        <p className="label-caps flex items-center gap-1.5 text-ink-subtle">
          <Icon name="circle-dashed" size={12} />No forecast yet
        </p>
        <h2 id="forecast-title" className="mt-1 text-base font-semibold">Too little history to forecast this role</h2>
      </div>
      <div className="p-4 md:p-5">
        <p className="text-xs leading-6 text-ink">{view.insufficientEvidence}</p>
        <dl className="mt-4 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
          {[
            ["Opening events", String(view.cycles.length)],
            ["Exact dates", String(view.precisionCounts.exact)],
            ["Bounded", String(view.precisionCounts.bounded)],
            ["Observed by", String(view.precisionCounts.observed_by)],
          ].map(([label, value]) => (
            <div key={label} className="bg-surface p-3">
              <dt className="label-caps text-ink-subtle">{label}</dt>
              <dd className="mt-1 text-sm font-semibold tabular text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="text-xs font-semibold text-ink">What to do now</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Watch this role to keep it on your watchlist and calendar; it gets a window as soon as the model can compute one. Until
            then, the roles at {view.company} that have a forecast show when the company tends to open.
          </p>
          {view.companyId && (
            <Link href={`/?company=${view.companyId}`} className="link-accent focus-ring mt-2 inline-flex min-h-touch items-center gap-1 text-xs">
              See every role at {view.company}<Icon name="arrow-right" size={13} />
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

export function RoleIntelligencePage({ view, welcome = null }: { view: RoleView; welcome?: Exclude<PlanOutcome, "none"> | null }) {
  const fixture = view.origin === "fixture";
  const forecast = view.forecast;
  // What the window mainly rests on, from the forecast's own date weights (lib/forecast-basis).
  const basis = forecast?.basis ?? null;
  const livePosting = view.currentPostings[0] ?? null;
  // The contribution receipts are paged in the URL, the way the dashboard and Replay page:
  // server-rendered, so every row is reachable by a link and none of it needs JavaScript.
  const provenancePages = Math.max(1, Math.ceil(view.provenanceTotal / PROVENANCE_PAGE_SIZE));
  const provenanceFirst = (view.provenancePage - 1) * PROVENANCE_PAGE_SIZE + 1;
  const provenanceLast = provenanceFirst + view.provenance.length - 1;
  const provenanceHref = (page: number) => `/roles/${view.id}${page > 1 ? `?evidence=${page}` : ""}#evidence`;
  // Every row of a contribution class carries that class's rationale — 18,554 rows across three of
  // them on the rig — so it is stated once, on the class. A class whose rows disagree says so per row.
  const ownRationale = new Set(view.provenanceGroups.filter((group) => !group.uniformRationale).map((group) => group.contribution));
  const statusLabel = livePosting
    ? "Posting currently observed"
    : view.cycles.length
      ? "Not currently observed open"
      : "No opening observed yet";
  const sections: Array<[string, string]> = [
    ["#forecast", "Forecast"],
    ["#history", "Evidence"],
    ["#evidence", "Provenance"],
    ["#readiness", "Readiness"],
    ["#signals", "Signals"],
    ["#metadata", "Model details"],
  ];

  return (
    <div className="flex-1 bg-canvas text-ink">
      <WorkspaceHeader
        contentId="role-content"
        status={fixture
          ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge>
          : <Badge className="border-success-line bg-success-surface text-success-ink">Real collected evidence</Badge>}
        actions={<FollowButton roleId={view.id} followed={view.isFollowed} itemId={view.watchlistItemId} disabled={fixture} />}
      />

      <main id="role-content" className="mx-auto max-w-[1440px] px-4 py-5 md:px-6 md:py-7">
        <nav className="mb-5 flex min-w-0 items-center gap-1 text-micro text-ink-subtle" aria-label="Breadcrumb">
          <Link href="/" className="focus-ring inline-flex min-h-touch items-center hover:text-accent-ink sm:min-h-0">All roles</Link><Icon name="chevron-right" size={11} />
          <span className="truncate">{view.company}</span><Icon name="chevron-right" size={11} /><span className="truncate text-ink-muted" aria-current="page">{view.role}</span>
        </nav>

        {welcome && (
          <div role="status" className="mb-5 flex flex-col gap-2 border-l-2 border-accent bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-sm leading-6 text-ink">{PLAN_OUTCOME_MESSAGES[welcome]}</p>
            <div className="flex shrink-0 flex-wrap gap-x-5 text-xs">
              <a href="#readiness" className="link-accent focus-ring inline-flex min-h-touch items-center">Go to the plan</a>
              <Link href="/?watched=1" className="link-accent focus-ring inline-flex min-h-touch items-center">Open your watchlist</Link>
            </div>
          </div>
        )}

        <section className="grid gap-5 border-b border-line pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end" aria-labelledby="role-title">
          <div className="min-w-0">
            <p className="label-caps text-ink-subtle">
              {[humanize(view.track), humanize(view.roleFamily), `${humanize(view.recruitingSeason)} season`, locationLabel(view.locationScope)].join(" · ")}
            </p>
            <p className="mt-3 text-sm font-semibold text-ink-muted">{view.company}</p>
            <h1 id="role-title" className="mt-1 text-2xl font-semibold tracking-title sm:text-3xl md:text-4xl">{view.role}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4">
              <span className="inline-flex min-h-touch items-center gap-1.5 text-xs font-semibold text-ink-muted"><Icon name="circle-dashed" size={14} />{statusLabel}</span>
              {view.careersUrl && <a href={view.careersUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-xs">Official career page<Icon name="arrow-up-right" size={13} /></a>}
              {livePosting?.applyUrl && <a href={livePosting.applyUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-xs">Open current posting<Icon name="arrow-up-right" size={13} /></a>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5 lg:border-l lg:border-line lg:pl-6">
            <div>
              <p className="label-caps text-ink-subtle">Predicted window</p>
              <p className="mt-1 text-xl font-semibold tracking-title tabular">
                {forecast ? `${day(forecast.windowStart)} – ${day(forecast.windowEnd)}` : "Not forecastable yet"}
              </p>
              <p className="mt-1 text-micro text-ink-subtle">
                {forecast ? `Expected ${day(forecast.expectedOpening)}` : "Insufficient recruiting cycles"}
              </p>
              {basis && <p className="mt-1.5"><ForecastBasisChip basis={basis} /></p>}
            </div>
            {forecast && <ConfidenceIndicator value={forecast.confidence} />}
          </div>
        </section>

        <nav className="sticky top-14 z-20 -mx-4 flex gap-1 overflow-x-auto border-b border-line bg-canvas px-4 md:-mx-6 md:px-6" aria-label="Role intelligence sections">
          {sections.map(([href, label]) => (
            <a key={href} href={href} className="focus-ring inline-flex min-h-touch shrink-0 items-center px-2 text-caption font-semibold text-ink-muted hover:text-accent-ink">{label}</a>
          ))}
        </nav>

        <div className="mt-6 grid items-start gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,.65fr)]">
          <div className="min-w-0 space-y-5">
            {forecast ? (
              <section id="forecast" className="panel scroll-mt-32" aria-labelledby="forecast-title">
                <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line px-4 py-3 md:px-5">
                  <div>
                    <p className="label-caps text-accent-ink">Current statistical forecast</p>
                    <h2 id="forecast-title" className="mt-1 text-base font-semibold">When this role is likely to open</h2>
                  </div>
                  <span className="text-micro tabular text-ink-subtle">Forecasted {stamp(forecast.forecastedAt)}</span>
                </div>
                {basis && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 md:px-5">
                    <span className="label-caps text-ink-subtle">What the window rests on</span>
                    <ForecastBasisChip basis={basis} />
                    <span className="text-caption text-ink-muted">{BASIS[basis.kind].meaning} <a href="#evidence" className="link-accent focus-ring">See the weights</a></span>
                  </div>
                )}
                <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_220px] md:p-5">
                  <WindowVisualization view={view} />
                  <dl className="grid grid-cols-2 border-l border-t border-line md:grid-cols-1">
                    {[
                      ["Expected date", day(forecast.expectedOpening)],
                      ["Confidence score", confidenceOutOf(forecast.confidence, 1)],
                      ["Recruiting cycles used", String(forecast.historyCount)],
                      ["Similar-program sample", forecast.priorEffectiveSampleSize.toFixed(1)],
                    ].map(([label, value]) => (
                      <div key={label} className="border-b border-r border-line p-3">
                        <dt className="text-micro text-ink-subtle">{label}</dt>
                        <dd className="mt-1 text-sm font-semibold tabular">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className="border-t border-line px-4 py-4 md:px-5">
                  <h3 className="label-caps text-ink-subtle">Why this confidence</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-3">
                    {forecast.confidenceFactors.map((factor) => (
                      <div key={factor.label} className="bg-surface p-3">
                        <dt className="text-micro text-ink-subtle">{factor.label}</dt>
                        <dd className={`mt-1 text-xs font-semibold tabular ${factorTone[factor.tone]}`}>{factor.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-micro text-ink-subtle">
                    Each factor runs from 0 to 1. Signals against and signal conflict lower the score; every other factor raises it.
                    Sparse recruiting history is capped: {forecast.historyCount} recruiting cycle{forecast.historyCount === 1 ? "" : "s"} with
                    {" "}{view.precisionCounts.exact} exact and {view.precisionCounts.observed_by} observed-by opening date{view.precisionCounts.observed_by === 1 ? "" : "s"}.
                    The score measures how much consistent evidence backs the window, not the chance that it is right.
                  </p>
                </div>
              </section>
            ) : (
              <InsufficientEvidence view={view} />
            )}

            <Section id="history" eyebrow="Recruiting record" title="Historical opening evidence">
              {view.cycles.length === 0 ? (
                <p className="p-5 text-xs text-ink-muted">No historical opening event has been reconstructed for this role yet.</p>
              ) : (
                <ol className="divide-y divide-line">
                  {view.cycles.slice(0, 24).map((cycle) => (
                    <li key={cycle.id} className="grid gap-3 px-4 py-4 md:grid-cols-[54px_190px_minmax(0,1fr)] md:px-5">
                      <span className="text-sm font-semibold tabular text-ink-muted">{cycle.openedOn.slice(0, 4)}</span>
                      <div>
                        <p className="text-sm font-semibold tabular">
                          {cycle.precision === "bounded" && cycle.windowStart
                            ? `${day(cycle.windowStart)} – ${day(cycle.openedOn)}`
                            : day(cycle.openedOn)}
                        </p>
                        <div className="mt-1.5"><PrecisionChip precision={cycle.precision} /></div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <SourceBadge kind={cycle.sourceKind === "archive" ? "archive" : "official"} />
                          {cycle.sourceUrl && (
                            <a href={cycle.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-micro sm:min-h-0">
                              source<Icon name="arrow-up-right" size={10} />
                            </a>
                          )}
                          {cycle.uncertaintyDays !== null && <span className="text-micro tabular text-ink-subtle">±{cycle.uncertaintyDays} days</span>}
                        </div>
                        <p className="mt-1 text-caption text-ink-muted">{precisionMeaning[cycle.precision]}</p>
                        <p className="mt-1 flex items-start gap-1.5 text-micro text-ink-subtle"><Icon name="info" size={11} className="mt-0.5" />{cycle.uncertaintyReason}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <div className="border-t border-line bg-surface-sunken px-4 py-3 text-micro text-ink-subtle md:px-5">
                {view.precisionCounts.exact} exact · {view.precisionCounts.bounded} bounded · {view.precisionCounts.observed_by} observed-by
              </div>
            </Section>

            <section id="evidence" className="scroll-mt-32 border border-source-official-line bg-surface" aria-labelledby="evidence-title">
              <div className="border-b border-line bg-source-official-surface px-4 py-4 md:px-5">
                <p className="label-caps flex items-center gap-1.5 text-source-official-ink"><Icon name="shield-check" size={12} />Provenance</p>
                <h2 id="evidence-title" className="mt-1 text-lg font-semibold tracking-title">Exactly what contributed to this forecast</h2>
                <p className="mt-1 text-caption text-ink-muted">Every row is a stored observation linked to this forecast version, with the hash of the content it was read from.</p>
              </div>
              {view.provenanceTotal === 0 ? (
                <p className="p-5 text-xs text-ink-muted">
                  {forecast
                    ? "This stored forecast has no linked evidence rows in this deployment."
                    : "Provenance appears once a forecast exists; contributions are recorded per stored forecast version."}
                </p>
              ) : (
                <>
                <table className="w-full border-b border-line text-caption">
                  <caption className="px-4 py-3 text-left text-micro text-ink-subtle md:px-5">
                    What the model weighed, over all {view.provenanceTotal.toLocaleString("en-US")} contributions.
                  </caption>
                  <thead>
                    <tr className="border-y border-line bg-surface-sunken text-left">
                      <th scope="col" className="label-caps px-4 py-2 font-medium text-ink-subtle md:px-5">Contribution</th>
                      <th scope="col" className="label-caps px-2 py-2 text-right font-medium text-ink-subtle">Observations</th>
                      <th scope="col" className="label-caps px-4 py-2 text-right font-medium text-ink-subtle md:px-5">Weight</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {view.provenanceGroups.map((group) => (
                      <tr key={group.contribution}>
                        <th scope="row" className="px-4 py-2.5 text-left font-semibold md:px-5">
                          {contributionLabel(group.contribution)}
                          <span className="mt-0.5 block text-micro font-normal text-ink-subtle">{group.rationale}</span>
                        </th>
                        <td className="px-2 py-2.5 text-right tabular align-top">{group.rows.toLocaleString("en-US")}</td>
                        <td className="px-4 py-2.5 text-right font-semibold tabular align-top md:px-5">{(group.weight * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 pt-4 text-micro text-ink-subtle md:px-5">
                  {view.provenanceTotal <= PROVENANCE_PAGE_SIZE
                    ? `Every contribution, with the record it was read from.`
                    : `Contributions ${provenanceFirst.toLocaleString("en-US")} to ${provenanceLast.toLocaleString("en-US")} of ${view.provenanceTotal.toLocaleString("en-US")}, heaviest first, each with the record it was read from.`}
                </p>
                <ol className="divide-y divide-line" start={provenanceFirst}>
                  {view.provenance.map((item, index) => (
                    <li key={`${item.observationId}-${item.contribution}`} className="grid gap-3 px-4 py-4 md:grid-cols-[28px_minmax(0,1fr)_150px] md:px-5">
                      <span className="grid h-6 w-6 place-items-center rounded-full border border-line-strong text-micro font-semibold tabular text-ink-muted" aria-hidden="true">{provenanceFirst + index}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-xs font-semibold">{contributionLabel(item.contribution)}</h3>
                          <SourceBadge kind={item.signalKind ? "signal" : item.extractionMethod === "archive" ? "archive" : "official"} />
                          {item.precision && <PrecisionChip precision={item.precision} variant="plain" />}
                        </div>
                        {ownRationale.has(item.contribution) && <p className="mt-1 text-caption text-ink-muted">{item.rationale}</p>}
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring mt-1 flex min-h-touch max-w-full items-center gap-1 text-micro font-medium sm:min-h-0">
                          <span className="truncate">{item.sourceUrl}</span><Icon name="arrow-up-right" size={10} />
                        </a>
                        <p className="mt-1 break-all font-mono text-micro text-ink-subtle"><span className="sr-only">Content hash </span>{item.contentHash.slice(0, 32)}… · {item.extractionMethod}</p>
                      </div>
                      <div className="flex items-baseline gap-2 md:block md:text-right">
                        <p className="text-xs font-semibold tabular">{(item.weight * 100).toFixed(1)}%</p>
                        <p className="text-micro text-ink-subtle">of the model&apos;s weight</p>
                        <p className="text-micro tabular text-ink-subtle md:mt-1">{stamp(item.observedAt)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {provenancePages > 1 && (
                  <nav className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 md:px-5" aria-label="Contribution pages">
                    {view.provenancePage > 1 ? (
                      <Link href={provenanceHref(view.provenancePage - 1)} className="link-accent focus-ring flex min-h-touch items-center gap-1 text-micro font-semibold sm:min-h-0">
                        <Icon name="arrow-left" size={11} />Previous
                      </Link>
                    ) : <span />}
                    <p className="text-micro text-ink-subtle">Page {view.provenancePage} of {provenancePages}</p>
                    {view.provenancePage < provenancePages ? (
                      <Link href={provenanceHref(view.provenancePage + 1)} className="link-accent focus-ring flex min-h-touch items-center gap-1 text-micro font-semibold sm:min-h-0">
                        Next<Icon name="arrow-right" size={11} />
                      </Link>
                    ) : <span />}
                  </nav>
                )}
                </>
              )}
            </section>

            <Section id="signals" eyebrow="Supporting evidence" title="Current recruiting signals" note="Signals carry zero date weight. They may only move confidence.">
              {view.signals.length === 0 ? (
                <p className="p-5 text-xs text-ink-muted">No recruiting signal has been recorded for this role.</p>
              ) : (
                <ol className="divide-y divide-line">
                  {view.signals.map((signal) => (
                    <li key={signal.id} className="grid gap-3 px-4 py-4 md:grid-cols-[24px_minmax(0,1fr)_auto] md:px-5">
                      <Icon name="radio" size={15} className="mt-0.5 text-source-signal-ink" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-xs font-semibold">{humanize(signal.kind)}</h3>
                          <SourceBadge kind={signal.kind === "community_recruiting_discussion" ? "community" : "signal"} />
                        </div>
                        <p className="mt-1 text-caption text-ink-muted">“{signal.evidenceQuote}”</p>
                        <p className="mt-1 truncate text-micro text-ink-subtle">Observed {stamp(signal.observedAt)} · {signal.sourceUrl}</p>
                      </div>
                      <div className="text-left md:text-right">
                        <p className="text-xs font-semibold tabular">{Math.round(signal.reliability * 100)}%</p>
                        <p className="text-micro text-ink-subtle">source reliability</p>
                        <p className="mt-1 text-micro tabular text-ink-subtle">strength {signal.strength.toFixed(2)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {view.signals.some((signal) => signal.kind === "community_recruiting_discussion") && (
                <div className="border-t border-line bg-surface-sunken px-4 py-3 text-micro text-ink-subtle md:px-5">
                  Community evidence is supporting-only and cannot confirm that applications opened.
                </div>
              )}
            </Section>

            <AgentInvestigation company={view.company} role={view.role} roleId={view.origin === "real" ? view.id : undefined} />
          </div>

          <aside className="min-w-0 space-y-5 xl:sticky xl:top-[104px]" aria-label="Preparation and model details">
            <section id="readiness" className="panel scroll-mt-32" aria-labelledby="readiness-title">
              <div className="border-b border-line px-4 py-3">
                <p className="label-caps text-ink-subtle">Work-back plan</p>
                <h2 id="readiness-title" className="mt-1 text-sm font-semibold">Application readiness</h2>
              </div>
              {view.milestones.length > 0 ? (
                <ol className="divide-y divide-line">
                  {view.milestones.map((milestone) => (
                    <li key={`${milestone.kind}-${milestone.dueOn}`} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs font-semibold text-ink">{milestoneLabels[milestone.kind] ?? humanize(milestone.kind)}</p>
                        <time dateTime={milestone.dueOn} className="shrink-0 text-caption font-medium tabular text-ink-muted">{day(milestone.dueOn)}</time>
                      </div>
                      <p className="mt-1 text-micro text-ink-subtle">{milestone.rationale}</p>
                      {milestone.dueOn !== milestone.idealDueOn && (
                        <p className="mt-1 text-micro text-warning-ink">Compressed: the ideal date {day(milestone.idealDueOn)} has already passed.</p>
                      )}
                    </li>
                  ))}
                  <li className="px-4 py-2.5 text-micro text-ink-subtle">Policy <span className="font-mono">{view.milestones[0].policyVersion}</span></li>
                </ol>
              ) : (
                <p className="p-4 text-caption text-ink-muted">
                  {view.isFollowed === null
                    ? <>A work-back plan is built from this role&apos;s prediction interval for a role you watch, and watching needs an account. <Link href={`/signin?mode=sign_up&return_to=${encodeURIComponent(`/roles/${view.id}`)}`} className="link-accent focus-ring">Create an account</Link></>
                    : view.isFollowed
                      ? forecast
                        ? "You follow this role. Generate the work-back plan to run the versioned readiness policy over this forecast interval; the milestones then appear here and in your recruiting calendar."
                        : "You follow this role. Preparation dates are worked back from a prediction interval, and this role does not have one yet."
                      : "Follow this role to generate a deterministic work-back plan from its prediction interval."}
                </p>
              )}
              {view.isFollowed === true && forecast && !fixture && <GenerateReadinessButton roleId={view.id} />}
            </section>

            <Section eyebrow="Version history" title="Forecast history">
              {view.forecastRefusal && (
                <p className="border-b border-line px-4 py-3 text-caption leading-5 text-ink-muted">
                  The model declined this role on {day(view.forecastRefusal.refusedAt)}, after its evidence changed:
                  {" "}&ldquo;{view.forecastRefusal.reason}&rdquo; The versions below are history, not a current window.
                </p>
              )}
              {view.forecastVersions.length === 0 ? (
                <p className="p-4 text-caption text-ink-muted">No stored forecast version exists for this role.</p>
              ) : (
                <ol className="divide-y divide-line">
                  {view.forecastVersions.map((version, index) => (
                    <li key={version.forecastId} className="px-4 py-3">
                      <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2">
                        <span className="text-micro font-medium tabular text-ink-subtle">{day(version.asOf)}</span>
                        <div>
                          <p className="text-caption font-semibold tabular">{day(version.windowStart)} – {day(version.windowEnd)}</p>
                          <p className="mt-0.5 text-micro text-ink-subtle">expected {day(version.expectedOpening)}</p>
                          {version.basis && <p className="mt-1"><ForecastBasisChip basis={version.basis} variant="plain" /></p>}
                        </div>
                        <div className="text-right">
                          <p className="text-caption font-semibold tabular" aria-label={`confidence score ${formatConfidence(version.confidence)} of 100`}>{formatConfidence(version.confidence)}<span className="text-micro font-medium text-ink-subtle"> / 100</span></p>
                          {index === 0 && view.forecast && <span className="label-caps text-accent-ink">current</span>}
                        </div>
                      </div>
                      {version.change && (
                        <p className="mt-2 border-l-2 border-warning-line bg-warning-surface px-2 py-1.5 text-micro text-warning-ink">
                          {version.change.confidenceDelta >= 0 ? "+" : ""}{version.change.confidenceDelta.toFixed(1)} points ·
                          {" "}{version.change.pointDateDeltaDays >= 0 ? "+" : ""}{version.change.pointDateDeltaDays} days ·
                          {" "}{version.change.reasons[0] ?? "recorded change"}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            {view.currentPostings.length > 0 && (
              <Section eyebrow="Observed now" title="Current postings">
                <ul className="divide-y divide-line">
                  {view.currentPostings.map((posting) => (
                    <li key={`${posting.title}-${posting.sourceUrl}`} className="px-4 py-3">
                      <p className="text-caption font-semibold">{posting.title}</p>
                      <p className="mt-1 text-micro text-ink-subtle">
                        {posting.publishedAt ? `Published ${day(posting.publishedAt)}` : "No source-supplied publication date"}
                        {posting.lastSeenAt ? ` · last seen ${day(posting.lastSeenAt)}` : ""}
                      </p>
                      {(posting.applyUrl ?? posting.sourceUrl) && (
                        <a href={(posting.applyUrl ?? posting.sourceUrl)!} target="_blank" rel="noreferrer" className="link-accent focus-ring mt-1 inline-flex min-h-touch items-center gap-1 text-micro sm:min-h-0">
                          Open posting<Icon name="arrow-up-right" size={10} />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <section id="metadata" className="panel scroll-mt-32 p-4" aria-labelledby="metadata-title">
              <div className="flex items-center gap-2"><Icon name="database" size={14} className="text-ink-subtle" /><h2 id="metadata-title" className="text-sm font-semibold">Model details</h2></div>
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-micro">
                {[
                  ["Model version", forecast?.modelVersion ?? "none", true],
                  ["Method", forecast?.method ?? "none", true],
                  ["Forecasted", forecast ? stamp(forecast.forecastedAt) : "—", false],
                  ["Input fingerprint", forecast ? `${forecast.inputFingerprint.slice(0, 16)}…` : "—", true],
                  ["Probability field (not calibrated)", forecast ? forecast.calibratedProbability.toFixed(3) : "—", false],
                  ["Recruiting cycles (history_count)", forecast ? String(forecast.historyCount) : "—", false],
                  ["Prior effective sample size", forecast ? forecast.priorEffectiveSampleSize.toFixed(1) : "—", false],
                  ["Location scope", view.locationScope, true],
                  ["Role identity", view.id, true],
                  ["Linked observations", String(view.observationCount), false],
                  ["Evidence policy", "provenance-required", true],
                ].map(([label, value, mono]) => (
                  <div key={String(label)} className="contents">
                    <dt className="text-ink-subtle">{label}</dt>
                    <dd className={`break-all text-right text-ink-muted ${mono ? "font-mono" : "tabular"}`} title={label === "Input fingerprint" ? forecast?.inputFingerprint : undefined}>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="panel p-4" aria-labelledby="precision-title">
              <div className="flex items-center gap-2"><Icon name="history" size={14} className="text-ink-subtle" /><h2 id="precision-title" className="text-sm font-semibold">Evidence precision</h2></div>
              <ul className="mt-3 space-y-2">
                {PRECISION_ORDER.map((precision) => (
                  <li key={precision} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0">
                    <div>
                      <PrecisionChip precision={precision} />
                      <p className="mt-1 text-micro text-ink-subtle">{precisionMeaning[precision]}</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular">{view.precisionCounts[precision]}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>

        {fixture && (
          <footer className="mt-7 border-t border-line py-4 text-micro text-ink-subtle">
            <p>Development fixture · reserved .example sources · not live recruiting advice</p>
          </footer>
        )}
      </main>
    </div>
  );
}
