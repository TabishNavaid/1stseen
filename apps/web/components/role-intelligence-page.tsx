import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { PROVENANCE_PAGE_SIZE } from "@/lib/role-view";
import type { DatePrecision, RoleView } from "@/lib/role-view";
import { AgentInvestigation } from "@/components/agent-investigation";
import { ConfidenceWord } from "@/components/confidence-word";
import { EvidenceMark } from "@/components/evidence-mark";
import { FollowButton } from "@/components/follow-button";
import { LikelyWindow } from "@/components/likely-window";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { GenerateReadinessButton } from "@/components/generate-readiness-button";
import { SourceBadge } from "@/components/source-badge";
import { confidenceOutOf, formatConfidence } from "@/lib/confidence";
import { formatDay, formatStamp } from "@/lib/dates";
import { BASIS } from "@/lib/forecast-basis";
import { PLAN_OUTCOME_MESSAGES, type PlanOutcome } from "@/lib/onboarding";
import { contributionLabel, humanize, locationLabel, uncertaintyReason } from "@/lib/presentation";

/**
 * Evidence precision must never blur. `exact` requires a source-supplied publication timestamp, `bounded` requires an
 * absence→presence transition, and `observed_by` means only that the role was visible by that date. On this page each
 * class is a small icon with its name and meaning in a tooltip (EvidenceMark), shown in the History section only; the
 * date beside it is written in plain words ("Seen open by …").
 */
/** A past opening in plain words; the icon beside it names its evidence class. */
function historyWords(cycle: RoleView["cycles"][number]): string {
  if (cycle.precision === "observed_by") return `Seen open by ${day(cycle.openedOn)}`;
  if (cycle.precision === "bounded" && cycle.windowStart) return `Opened between ${day(cycle.windowStart)} and ${day(cycle.openedOn)}`;
  return `Opened ${day(cycle.openedOn)}`;
}

const PRECISION_COUNT_LABEL: Record<DatePrecision, string> = { exact: "Exact dates", bounded: "Bounded dates", observed_by: "Observed by dates" };

const milestoneLabels: Record<string, string> = {
  networking: "Start networking",
  referral_contacts: "Identify referral contacts",
  resume_ready: "Resume ready",
  portfolio_ready: "Portfolio ready",
  high_alert: "High-alert monitoring",
};

const factorTone = { positive: "text-success-ink", warning: "text-warning-ink", neutral: "text-ink" } as const;

function day(value: string | null): string {
  return value ? formatDay(value) : "None";
}

function stamp(value: string | null): string {
  return value ? formatStamp(value) : "None";
}

function Section({ id, title, note, children }: {
  id?: string; title: string; note?: string; children: React.ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className="panel scroll-mt-32" aria-labelledby={headingId} aria-label={headingId ? undefined : title}>
      <div className="border-b border-line px-4 py-3 md:px-5">
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
      className="rounded-card border border-line bg-surface-sunken p-4"
      aria-label={`Likely window ${day(forecast.windowStart)} to ${day(forecast.windowEnd)}, most likely ${day(forecast.expectedOpening)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-caps text-ink-subtle">Likely window</span>
        <span className="text-micro tabular text-ink-subtle">
          {forecast.daysUntilWindow >= 0 ? `${forecast.daysUntilWindow} days until it starts` : "The interval has started"}
        </span>
      </div>
      <div className="relative mt-8 h-10" aria-hidden="true">
        <div className="absolute inset-x-0 top-3 h-px bg-line-strong" />
        <div className="absolute left-[14%] top-[7px] h-3 w-[72%] rounded-full border border-dashed border-date-predicted-line bg-date-predicted-surface" />
        <div className="absolute left-1/2 top-0 h-7 w-px bg-accent">
          <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-micro font-semibold text-accent-ink">
            most likely {day(forecast.expectedOpening)}
          </span>
        </div>
        <span className="absolute left-0 top-6 whitespace-nowrap text-micro font-medium tabular text-ink-muted">{day(forecast.windowStart)}</span>
        <span className="absolute right-0 top-6 whitespace-nowrap text-micro font-medium tabular text-ink-muted">{day(forecast.windowEnd)}</span>
      </div>
      <figcaption className="mt-4 flex gap-2 text-micro text-ink-subtle">
        <Icon name="info" size={12} className="mt-0.5" />
        <span>The window holds 80% of the likely dates; the line marks the single most likely one.</span>
      </figcaption>
    </figure>
  );
}

/** A block inside "How this forecast was made": a small heading, an optional note, and its content. */
function Detail({ id, title, note, children }: { id?: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line px-4 py-5 md:px-6" aria-labelledby={id ? `${id}-title` : undefined} aria-label={id ? undefined : title}>
      <h3 id={id ? `${id}-title` : undefined} className="text-sm font-semibold text-ink">{title}</h3>
      {note && <p className="mt-1 text-caption text-ink-subtle">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * A role page in the order a person needs it: when it is likely to open and a way to save it, when it opened before
 * with the sources, how to get ready, and a way to ask. Everything the model used (its window, weights, sources,
 * versions, and fields) is in one collapsed "How this forecast was made", and a section with nothing in it is not drawn.
 */
export function RoleIntelligencePage({ view, welcome = null }: { view: RoleView; welcome?: Exclude<PlanOutcome, "none"> | null }) {
  const fixture = view.origin === "fixture";
  const forecast = view.forecast;
  // What the window mainly rests on, from the forecast's own date weights (lib/forecast-basis).
  const basis = forecast?.basis ?? null;
  const livePosting = view.currentPostings[0] ?? null;
  // The evidence classes the role has dates in; a class with no dates is left out.
  const recordedPrecisions = (["exact", "bounded", "observed_by"] as const).filter((precision) => view.precisionCounts[precision] > 0);
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
    ? "Open now"
    : view.cycles.length
      ? "Not currently observed open"
      : "No opening observed yet";
  const place = view.place ?? locationLabel(view.locationScope);
  const eyebrow = [humanize(view.track), view.recruitingSeason === "unknown" ? null : `${humanize(view.recruitingSeason)} season`, place === "Location not stated" ? null : place].filter(Boolean).join(" · ");
  const signUp = `/signin?mode=sign_up&return_to=${encodeURIComponent(`/roles/${view.id}`)}`;

  return (
    <div className="flex-1 bg-canvas text-ink">
      <main id="role-content" className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <nav className="mb-5 flex min-w-0 items-center gap-1 text-caption text-ink-subtle" aria-label="Breadcrumb">
          <Link href="/roles" className="focus-ring inline-flex min-h-touch shrink-0 items-center whitespace-nowrap rounded-sm hover:text-accent-ink sm:min-h-0">All programs</Link><Icon name="chevron-right" size={11} className="shrink-0" />
          <span className="truncate">{view.company}</span><Icon name="chevron-right" size={11} className="shrink-0" /><span className="truncate text-ink-muted" aria-current="page">{view.role}</span>
        </nav>

        {welcome && (
          <div role="status" className="mb-5 flex flex-col gap-2 rounded-card border border-accent bg-accent-soft px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-sm leading-6 text-ink">{PLAN_OUTCOME_MESSAGES[welcome]}</p>
            <div className="flex shrink-0 flex-wrap gap-x-5 text-xs">
              <a href="#readiness" className="link-accent focus-ring inline-flex min-h-touch items-center">Go to the plan</a>
              <Link href="/roles?watched=1" className="link-accent focus-ring inline-flex min-h-touch items-center">Open your watchlist</Link>
            </div>
          </div>
        )}

        <section className="card grid gap-6 p-5 md:p-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end" aria-labelledby="role-title">
          <div className="min-w-0">
            {eyebrow && <p className="text-caption font-semibold text-ink-subtle">{eyebrow}</p>}
            <p className="mt-3 text-sm font-semibold text-ink-muted">{view.company}</p>
            <h1 id="role-title" className="heading-display mt-1 text-3xl leading-tight sm:text-4xl md:text-5xl">{view.role}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4">
              <span className="inline-flex min-h-touch items-center gap-1.5 text-xs font-semibold text-ink-muted"><Icon name="circle-dashed" size={14} />{statusLabel}</span>
              {view.careersUrl && <a href={view.careersUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-xs">Official career page<Icon name="arrow-up-right" size={13} /></a>}
              {livePosting?.applyUrl && <a href={livePosting.applyUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-xs">Open current posting<Icon name="arrow-up-right" size={13} /></a>}
            </div>
          </div>
          <div className="rounded-card bg-surface-sunken p-4 sm:p-5 lg:min-w-[320px]">
            {forecast ? (
              <LikelyWindow outlook={{ expected: forecast.expectedOpening, start: forecast.windowStart, end: forecast.windowEnd }} size="lg" />
            ) : (
              <div>
                <p className="text-caption font-semibold text-ink-subtle">Likely around</p>
                <p className="heading-display mt-0.5 text-2xl text-ink">No date yet</p>
                <p className="mt-1 max-w-xs text-caption text-ink-muted">Not enough history to predict the next opening.</p>
                {view.companyId && (
                  <Link href={`/roles?company=${view.companyId}`} className="link-accent focus-ring mt-1 inline-flex min-h-touch items-center gap-1 text-caption">
                    See every role at {view.company}<Icon name="arrow-right" size={12} />
                  </Link>
                )}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {forecast && <ConfidenceWord value={forecast.confidence} align="start" />}
              <FollowButton roleId={view.id} followed={view.isFollowed} itemId={view.watchlistItemId} disabled={fixture} />
            </div>
          </div>
        </section>

        <div className="mt-6 space-y-5">
          {view.cycles.length > 0 && (
            <Section id="history" title="When it opened before">
              <ol className="divide-y divide-line">
                {view.cycles.slice(0, 24).map((cycle) => (
                  <li key={cycle.id} className="flex items-start gap-3 px-4 py-4 md:px-5">
                    <EvidenceMark precision={cycle.precision} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold tabular text-ink">{historyWords(cycle)}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                        <SourceBadge kind={cycle.sourceKind === "archive" ? "archive" : "official"} />
                        {cycle.sourceUrl && (
                          <a href={cycle.sourceUrl} target="_blank" rel="noreferrer" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 sm:min-h-0">
                            Source<Icon name="arrow-up-right" size={11} />
                          </a>
                        )}
                        {cycle.uncertaintyDays ? <span className="tabular text-ink-subtle">give or take {cycle.uncertaintyDays} days</span> : null}
                      </p>
                      {uncertaintyReason(cycle.uncertaintyReason) && <p className="mt-1 text-micro text-ink-subtle">{uncertaintyReason(cycle.uncertaintyReason)}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          <Section id="readiness" title="Get ready before it opens">
            {view.milestones.length > 0 ? (
              <ol className="divide-y divide-line">
                {view.milestones.map((milestone) => (
                  <li key={`${milestone.kind}-${milestone.dueOn}`} className="px-4 py-3 md:px-5">
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
              </ol>
            ) : (
              <p className="px-4 py-4 text-caption leading-5 text-ink-muted md:px-5">
                {view.isFollowed === null
                  ? <>{forecast
                      ? "Save this program to your watchlist and 1stSeen works back from its likely date: when to start networking, and when your résumé should be ready."
                      : "Save this program to your watchlist, and once it has a likely date 1stSeen works back from it: when to start networking, and when your résumé should be ready."}
                    {" "}Saving needs a free account. <Link href={signUp} className="link-accent focus-ring">Create an account</Link></>
                  : view.isFollowed
                    ? forecast
                      ? "It is on your watchlist. Build the prep plan to work back from its window; the dates then appear here and on your calendar."
                      : "It is on your watchlist. A prep plan works back from a likely date, and this program does not have one yet."
                    : "Save it to your watchlist to get a prep plan worked back from its likely date."}
              </p>
            )}
            {view.isFollowed === true && forecast && !fixture && <div className="px-4 pb-4 md:px-5"><GenerateReadinessButton roleId={view.id} /></div>}
          </Section>

          <AgentInvestigation company={view.company} role={view.role} roleId={view.origin === "real" ? view.id : undefined} />

          <details id="how-made" className="panel group scroll-mt-24" open={view.provenancePage > 1}>
            <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 rounded-panel px-4 py-4 md:px-6 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-base font-semibold text-ink">{forecast ? "How this forecast was made" : "Why there is no date yet"}</span>
                <span className="mt-0.5 block text-caption text-ink-subtle">
                  {forecast
                    ? "The window, the sources and their weights, earlier versions, and the model\u2019s details."
                    : "What the model needs before it can date this program, and the model\u2019s details."}
                </span>
              </span>
              <Icon name="chevron-down" size={16} className="shrink-0 text-ink-subtle transition-transform group-open:rotate-180" />
            </summary>

            {forecast ? (
              <Detail id="forecast" title="The likely window" note={`Forecasted ${stamp(forecast.forecastedAt)}.`}>
                <WindowVisualization view={view} />
                {basis && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <span className="label-caps text-ink-subtle">What the window rests on</span>
                    <ForecastBasisChip basis={basis} />
                    <span className="text-caption text-ink-muted">{BASIS[basis.kind].meaning}</span>
                  </div>
                )}
                <dl className="mt-4 grid grid-cols-2 overflow-hidden rounded-card border-l border-t border-line sm:grid-cols-4">
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
                <h4 className="mt-4 label-caps text-ink-subtle">Why this confidence</h4>
                <dl className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-control border border-line bg-line lg:grid-cols-3">
                  {forecast.confidenceFactors.map((factor) => (
                    <div key={factor.label} className="bg-surface p-3">
                      <dt className="text-micro text-ink-subtle">{factor.label}</dt>
                      <dd className={`mt-1 text-xs font-semibold tabular ${factorTone[factor.tone]}`}>{factor.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-micro text-ink-subtle">
                  Each factor runs from 0 to 1. Signals against and signal conflict lower the score; every other factor raises it.
                  Sparse recruiting history is capped: {forecast.historyCount} recruiting cycle{forecast.historyCount === 1 ? "" : "s"} behind this window.
                  The score measures how much consistent evidence backs the window, not the chance that it is right.
                </p>
              </Detail>
            ) : (
              <Detail id="forecast" title="Too little history to forecast this role">
                <p className="text-xs leading-6 text-ink">{view.insufficientEvidence}</p>
                <p className="mt-2 text-xs text-ink-muted">
                  {view.cycles.length === 1 ? "One past opening" : `${view.cycles.length.toLocaleString("en-US")} past openings`} on record.
                  It gets a likely date as soon as the model can compute one.
                </p>
              </Detail>
            )}

            {recordedPrecisions.length > 0 && (
              <Detail title="Past openings by how their date is known">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-ink-muted">
                  {recordedPrecisions.map((precision) => (
                    <span key={precision} className="inline-flex items-center gap-2">
                      <EvidenceMark precision={precision} />
                      <span><span className="sr-only">{PRECISION_COUNT_LABEL[precision]}: </span><span className="tabular font-semibold text-ink">{view.precisionCounts[precision]}</span></span>
                    </span>
                  ))}
                </div>
              </Detail>
            )}

            {view.provenanceTotal > 0 && (
              <Detail id="evidence" title="Sources and weights" note="Every row is a record the model read, with the page it came from and how much it counted.">
                <table className="w-full border-y border-line text-caption">
                  <caption className="py-2 text-left text-micro text-ink-subtle">
                    What the model weighed, over all {view.provenanceTotal.toLocaleString("en-US")} contributions.
                  </caption>
                  <thead>
                    <tr className="border-y border-line bg-surface-sunken text-left">
                      <th scope="col" className="label-caps px-3 py-2 font-medium text-ink-subtle">Contribution</th>
                      <th scope="col" className="label-caps px-2 py-2 text-right font-medium text-ink-subtle">Observations</th>
                      <th scope="col" className="label-caps px-3 py-2 text-right font-medium text-ink-subtle">Weight</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {view.provenanceGroups.map((group) => (
                      <tr key={group.contribution}>
                        <th scope="row" className="px-3 py-2.5 text-left font-semibold">
                          {contributionLabel(group.contribution)}
                          <span className="mt-0.5 block text-micro font-normal text-ink-subtle">{group.rationale}</span>
                        </th>
                        <td className="px-2 py-2.5 text-right tabular align-top">{group.rows.toLocaleString("en-US")}</td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular align-top">{(group.weight * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="pt-4 text-micro text-ink-subtle">
                  {view.provenanceTotal <= PROVENANCE_PAGE_SIZE
                    ? `Every contribution, with the record it was read from.`
                    : `Contributions ${provenanceFirst.toLocaleString("en-US")} to ${provenanceLast.toLocaleString("en-US")} of ${view.provenanceTotal.toLocaleString("en-US")}, heaviest first, each with the record it was read from.`}
                </p>
                <ol className="divide-y divide-line" start={provenanceFirst}>
                  {view.provenance.map((item, index) => (
                    <li key={`${item.observationId}-${item.contribution}`} className="grid gap-3 py-4 md:grid-cols-[28px_minmax(0,1fr)_150px]">
                      <span className="grid h-6 w-6 place-items-center rounded-full border border-line-strong text-micro font-semibold tabular text-ink-muted" aria-hidden="true">{provenanceFirst + index}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-xs font-semibold">{contributionLabel(item.contribution)}</h4>
                          <SourceBadge kind={item.signalKind ? "signal" : item.extractionMethod === "archive" ? "archive" : "official"} />
                        </div>
                        {ownRationale.has(item.contribution) && <p className="mt-1 text-caption text-ink-muted">{item.rationale}</p>}
                        {/* The content fingerprint stays on the record, and in the link's title for anyone tracing it; it is not page text. */}
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer" title={`Content fingerprint ${item.contentHash}`} className="link-accent focus-ring mt-1 flex min-h-touch max-w-full items-center gap-1 text-micro font-medium sm:min-h-0">
                          <span className="truncate">{item.sourceUrl}</span><Icon name="arrow-up-right" size={10} />
                        </a>
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
                  <nav className="flex items-center justify-between gap-3 border-t border-line pt-3" aria-label="Contribution pages">
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
              </Detail>
            )}

            {view.signals.length > 0 && (
              <Detail id="signals" title="Recruiting news" note="News about hiring never moves the date. It can only raise or lower confidence.">
                <ol className="divide-y divide-line">
                  {view.signals.map((signal) => (
                    <li key={signal.id} className="grid gap-3 py-4 md:grid-cols-[24px_minmax(0,1fr)_auto]">
                      <Icon name="radio" size={15} className="mt-0.5 text-source-signal-ink" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-xs font-semibold">{humanize(signal.kind)}</h4>
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
                {view.signals.some((signal) => signal.kind === "community_recruiting_discussion") && (
                  <p className="mt-2 text-micro text-ink-subtle">Community evidence is supporting-only and cannot confirm that applications opened.</p>
                )}
              </Detail>
            )}

            {view.currentPostings.length > 0 && (
              <Detail title="Postings we see now">
                <ul className="divide-y divide-line">
                  {view.currentPostings.map((posting) => (
                    <li key={`${posting.title}-${posting.sourceUrl}`} className="py-3">
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
              </Detail>
            )}

            {(view.forecastVersions.length > 0 || view.forecastRefusal) && (
              <Detail title="Earlier versions of this forecast">
                {view.forecastRefusal && (
                  <p className="mb-3 text-caption leading-5 text-ink-muted">
                    The model declined this role on {day(view.forecastRefusal.refusedAt)}, after its evidence changed:
                    {" "}&ldquo;{view.forecastRefusal.reason}&rdquo; The versions below are history, not a current window.
                  </p>
                )}
                {view.forecastVersions.length > 0 && <ol className="divide-y divide-line rounded-card border border-line">
                  {view.forecastVersions.map((version, index) => (
                    <li key={version.forecastId} className="px-3 py-3">
                      <div className="grid grid-cols-[88px_minmax(0,1fr)_auto] gap-2">
                        <span className="text-micro font-medium tabular text-ink-subtle">{day(version.asOf)}</span>
                        <div>
                          <p className="text-caption font-semibold tabular">{day(version.windowStart)} – {day(version.windowEnd)}</p>
                          <p className="mt-0.5 text-micro text-ink-subtle">expected {day(version.expectedOpening)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-caption font-semibold tabular" aria-label={`confidence score ${formatConfidence(version.confidence)} of 100`}>{formatConfidence(version.confidence)}<span className="text-micro font-medium text-ink-subtle"> / 100</span></p>
                          {index === 0 && view.forecast && <span className="label-caps text-accent-ink">current</span>}
                        </div>
                      </div>
                      {version.change && (
                        <p className="mt-2 border-l-2 border-warning-line bg-warning-surface px-2 py-1.5 text-micro text-warning-ink">
                          {version.change.notes.join(" · ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>}
              </Detail>
            )}

            <Detail id="metadata" title="Model details">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-micro">
                {[
                  ["Model version", forecast?.modelVersion ?? "None", true],
                  ["Method", forecast?.method ? humanize(forecast.method) : "None", false],
                  ["Forecasted", forecast ? stamp(forecast.forecastedAt) : "None", false],
                  ["Probability (not yet calibrated)", forecast ? forecast.calibratedProbability.toFixed(3) : "None", false],
                  ["Recruiting cycles", forecast ? String(forecast.historyCount) : "None", false],
                  ["Similar-program sample", forecast ? forecast.priorEffectiveSampleSize.toFixed(1) : "None", false],
                  ["Location", place, false],
                  ["Linked observations", String(view.observationCount), false],
                  ...(view.milestones.length ? [["Prep plan rules", view.milestones[0].policyVersion, true] as const] : []),
                ].map(([label, value, mono]) => (
                  <div key={String(label)} className="contents">
                    <dt className="text-ink-subtle">{label}</dt>
                    <dd className={`break-words text-right text-ink-muted ${mono ? "font-mono" : "tabular"}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            </Detail>
          </details>
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
