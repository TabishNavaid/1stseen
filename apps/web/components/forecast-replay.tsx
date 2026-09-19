"use client";

import { useState } from "react";
import { REPLAY_UNAVAILABLE_MESSAGE } from "@/lib/agent-availability";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { forecastReplayResultSchema, type ForecastReplayResult } from "@firstseen/shared";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { forecastBasis } from "@/lib/forecast-basis";
import { PrecisionChip } from "@/components/precision-chip";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import type { ReplayCandidate, ReplayCandidateData } from "@/lib/real-data";
import { REPLAY_OUTCOMES, REPLAY_PAGE_SIZE, replayHref, replayOutcomeLabel } from "@/lib/replay-query";
import { formatDay as day } from "@/lib/dates";

const kindLabel: Record<string, string> = {
  role_history: "Role history",
  company_prior: "Company prior",
  role_family_prior: "Role-family prior",
  signal: "Signal",
};

type ReplayState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "result"; result: ForecastReplayResult }
  | { status: "not_evaluable"; reason: string }
  | { status: "error"; message: string };

const fieldClass = "control mt-1.5 px-3 font-semibold";
const labelClass = "label-caps text-ink-subtle";
const primaryButton = "min-h-touch gap-2 md:min-h-0";

function OutcomeCell({ candidate }: { candidate: ReplayCandidate }) {
  if (candidate.latestOutcome === null) return <span className="text-micro text-ink-subtle">No backtest persisted</span>;
  const tone = candidate.latestOutcome === "scored" ? "text-success-ink" : candidate.latestOutcome === "skipped" ? "text-warning-ink" : "text-ink-muted";
  return (
    <div>
      <p className={`text-micro font-semibold ${tone}`}>{replayOutcomeLabel[candidate.latestOutcome]}</p>
      {candidate.skipReason && <p className="mt-0.5 text-micro text-ink-subtle">{candidate.skipReason}</p>}
    </div>
  );
}

function SelectButton({ candidate, selected, onChoose }: { candidate: ReplayCandidate; selected: boolean; onChoose: () => void }) {
  return (
    <button type="button" onClick={onChoose} aria-pressed={selected} aria-label={`Use ${candidate.company} ${candidate.role}, ${candidate.targetYear}, as the held-out target`} className={`focus-ring h-8 rounded-control border px-3 text-micro font-semibold max-md:h-touch ${selected ? "border-accent bg-accent text-ink-inverse" : "border-line-strong bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink"}`}>
      {selected ? "Selected" : "Select"}
    </button>
  );
}

export function ForecastReplay({ data }: { data: ReplayCandidateData }) {
  const { mode, filters, candidates, summary, companies, backtest, apiConfigured } = data;
  const [selection, setSelection] = useState(candidates[0]?.key ?? "");
  const [cutoff, setCutoff] = useState(candidates[0]?.suggestedCutoff ?? "");
  const [showOutcome, setShowOutcome] = useState(false);
  const [state, setState] = useState<ReplayState>({ status: "idle" });
  const selected = candidates.find((item) => item.key === selection) ?? candidates[0] ?? null;

  function choose(candidate: ReplayCandidate) {
    setSelection(candidate.key);
    setCutoff(candidate.suggestedCutoff);
    setShowOutcome(false);
    setState({ status: "idle" });
  }

  async function run() {
    if (!selected) return;
    setState({ status: "running" });
    setShowOutcome(false);
    try {
      const response = await fetch("/api/forecast-replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role_id: selected.roleId,
          target_year: selected.targetYear,
          forecast_cutoff: cutoff,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; reason?: string; message?: string };
      if (response.status === 422 && payload.error === "replay_not_evaluable") {
        setState({ status: "not_evaluable", reason: payload.reason ?? "This case cannot be scored leak-free." });
        return;
      }
      if (!response.ok) {
        setState({
          status: "error",
          message: payload.error === "replay_api_unavailable"
            ? "The replay service is not configured for this environment."
            : payload.error === "replay_api_unreachable" || payload.error === "replay_api_failed"
              ? payload.message ?? REPLAY_UNAVAILABLE_MESSAGE
            : payload.error === "unauthorized"
              ? "Create an account or sign in to run a historical replay."
              : "The replay could not be run.",
        });
        return;
      }
      const parsed = forecastReplayResultSchema.safeParse(payload);
      if (!parsed.success) {
        setState({ status: "error", message: "The replay service returned a result that failed leak-safety validation." });
        return;
      }
      setState({ status: "result", result: parsed.data });
    } catch {
      setState({ status: "error", message: "The replay could not be run." });
    }
  }

  const result = state.status === "result" ? state.result : null;
  const resultBasis = result && result.own_history_weight !== undefined && result.borrowed_weight !== undefined
    ? forecastBasis(result.own_history_weight, result.borrowed_weight)
    : null;
  const pageCount = Math.max(1, Math.ceil(summary.matching / REPLAY_PAGE_SIZE));
  const firstShown = summary.matching === 0 ? 0 : (filters.page - 1) * REPLAY_PAGE_SIZE + 1;
  const lastShown = Math.min(summary.matching, (filters.page - 1) * REPLAY_PAGE_SIZE + candidates.length);
  const filtered = Boolean(filters.company || filters.query.trim() || filters.precision !== "all" || filters.outcome !== "all");

  return (
    <div className="flex-1 bg-canvas text-ink">

      <main id="replay-content" className="mx-auto max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        <section className="grid gap-5 border-b border-line pb-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-end"><div><p className="flex items-center gap-2 label-caps text-accent-ink"><Icon name="history" size={13} />Historical model audit</p><h1 className="heading-display mt-3 text-3xl md:text-4xl">Forecast Replay</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">Return to a historical cutoff and reconstruct what 1stSeen could have predicted—using only evidence the system actually knew by then. Every run is computed by the worker&rsquo;s leak-safe backtest when you ask for it.</p></div><div className="flex items-start gap-3 border-l-2 border-success-line bg-success-surface px-4 py-3"><Icon name="lock-keyhole" size={16} className="mt-0.5 shrink-0 text-success-ink" /><div><p className="text-xs font-semibold">Future evidence is sealed</p><p className="mt-1 text-micro leading-4 text-ink-muted">The held-out opening and every post-cutoff observation are scoring data only. They cannot enter the forecasting component.</p></div></div></section>

        {mode === "unconfigured" && (
          <section className="mt-6 border border-danger-line bg-danger-surface p-5"><h2 className="text-sm font-semibold text-danger-ink">Live data is not configured</h2><p className="mt-1.5 text-caption leading-5 text-danger-ink">Replay reads real reconstructed openings. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.</p></section>
        )}

        {mode === "real" && summary.candidates === 0 && (
          <section className="panel mt-6 p-5" aria-label="No evaluable replay case">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Icon name="circle-dashed" size={15} className="text-ink-subtle" />No historical case can be replayed yet</h2>
            <p className="mt-2 max-w-3xl text-caption leading-5 text-ink-muted">
              A replay holds out an opening whose actual date is known, an exact or bounded one. Of{" "}
              <strong className="font-semibold">{summary.rolesWithHistory}</strong> role{summary.rolesWithHistory === 1 ? "" : "s"} with two
              or more recorded openings, <strong className="font-semibold">{summary.observedByOnly}</strong> have only
              {" "}observed-by openings, which prove a role was visible by a date, not that it opened then.
            </p>
            <p className="mt-3 max-w-3xl text-caption leading-5 text-ink-muted">
              A cycle becomes replayable once 1stSeen observes its opening with a source-supplied publication date, or a complete
              absence-to-presence archive transition.
            </p>
          </section>
        )}

        {mode === "real" && summary.candidates > 0 && <>
          <div className="mt-6 grid items-start gap-5 lg:grid-cols-2">
            <section className="panel p-4" aria-labelledby="replay-scope-title">
              <p className="label-caps text-accent-ink">What can be replayed</p>
              <h2 id="replay-scope-title" className="mt-1 text-sm font-semibold">Held-out targets with a defensible actual interval</h2>
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-caption">
                <dt className="text-ink-muted">Roles with two or more recorded openings</dt><dd className="text-right font-semibold tabular">{summary.rolesWithHistory}</dd>
                <dt className="text-ink-muted">Excluded: only observed-by evidence</dt><dd className="text-right font-semibold tabular">{summary.observedByOnly}</dd>
                <dt className="text-ink-muted">Replay candidates</dt><dd className="text-right font-semibold tabular">{summary.candidates}</dd>
                <dt className="pl-3 text-ink-muted">held out on an <PrecisionChip variant="code" precision="exact" /> opening</dt><dd className="text-right tabular">{summary.exactCandidates}</dd>
                <dt className="pl-3 text-ink-muted">held out on a <PrecisionChip variant="code" precision="bounded" /> opening</dt><dd className="text-right tabular">{summary.boundedCandidates}</dd>
              </dl>
              <p className="mt-3 text-micro leading-4 text-ink-subtle">An archive capture proves a role was visible by then, not that it opened then, so an observed-by opening is never scored as ground truth.</p>
            </section>

            <section className="panel p-4" aria-labelledby="backtest-reasons-title">
              <p className="label-caps text-warning-ink">Latest persisted backtest</p>
              <h2 id="backtest-reasons-title" className="mt-1 text-sm font-semibold">Why targets could not be scored</h2>
              {backtest === null ? (
                <p className="mt-3 text-caption leading-5 text-ink-muted">No backtest has been persisted yet. Run <code className="font-mono">firstseen backtest</code> to record which targets the leak-safe evaluator can score and why the rest are skipped.</p>
              ) : (
                <>
                  <p className="mt-1 text-micro text-ink-subtle">Finished {day(backtest.finishedAt.slice(0, 10))} · cutoff {backtest.cutoffDays} days before each target · {backtest.targetCount} targets, {backtest.completedCases} scored, {backtest.skippedCases} skipped</p>
                  {backtest.reasons.length === 0 ? (
                    <p className="mt-3 text-caption text-ink-muted">That run skipped no targets.</p>
                  ) : (
                    <ul className="mt-3 space-y-2.5">
                      {backtest.reasons.map((item) => (
                        <li key={item.reason}>
                          <div className="flex items-baseline justify-between gap-3 text-caption"><span className="text-ink">{item.reason}</span><span className="shrink-0 font-semibold tabular">{item.targets}</span></div>
                          <div className="mt-1 h-1.5 bg-confidence-track" aria-hidden="true"><div className="h-1.5 bg-warning-line" style={{ width: `${backtest.targetCount ? Math.max(1, Math.round((item.targets / backtest.targetCount) * 100)) : 0}%` }} /></div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 text-micro leading-4 text-ink-subtle">Counted over every reconstructed cycle the backtest evaluated, which is more than the replay candidates above. Reasons are the backtest&rsquo;s own words.</p>
                </>
              )}
            </section>
          </div>

          <section className="mt-5 panel" aria-labelledby="replay-candidates-title">
            <div className="border-b border-line px-4 py-3"><h2 id="replay-candidates-title" className="text-sm font-semibold">Choose a held-out target</h2><p className="mt-1 text-micro text-ink-muted" aria-live="polite">{summary.matching === 0 ? "No candidates match these filters" : `Showing ${firstShown}–${lastShown} of ${summary.matching}${filtered ? ` matching (${summary.candidates} in total)` : ""}`}</p></div>

            <form method="get" action="/replay" className="grid gap-3 border-b border-line p-4 md:grid-cols-[1fr_1.2fr_0.8fr_1.2fr_auto] md:items-end" aria-label="Filter replay candidates">
              <label className="block"><span className={labelClass}>Company</span><select name="company" defaultValue={filters.company} className={fieldClass}><option value="">All companies</option>{companies.map((company) => <option key={company.name} value={company.name}>{company.name} ({company.candidates})</option>)}</select></label>
              <label className="block"><span className={labelClass}>Role contains</span><input type="search" name="q" defaultValue={filters.query} maxLength={200} className={fieldClass} /></label>
              <label className="block"><span className={labelClass}>Target precision</span><select name="precision" defaultValue={filters.precision === "all" ? "" : filters.precision} className={fieldClass}><option value="">Exact and bounded</option><option value="exact">Exact ({summary.exactCandidates})</option><option value="bounded">Bounded ({summary.boundedCandidates})</option></select></label>
              <label className="block"><span className={labelClass}>Latest backtest</span><select name="outcome" defaultValue={filters.outcome === "all" ? "" : filters.outcome} disabled={backtest === null} aria-describedby={backtest === null ? "outcome-filter-note" : undefined} className={fieldClass}><option value="">Any outcome</option>{REPLAY_OUTCOMES.map((outcome) => <option key={outcome} value={outcome}>{replayOutcomeLabel[outcome]}</option>)}</select>{backtest === null && <span id="outcome-filter-note" className="mt-1 block text-micro text-ink-subtle">Available once a backtest has been persisted.</span>}</label>
              <div className="flex gap-2"><Button type="submit" className={primaryButton}><Icon name="filter" size={13} />Apply</Button>{filtered && <Link href="/replay" className="focus-ring inline-flex h-10 items-center rounded-control border border-line-strong px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch">Clear</Link>}</div>
            </form>

            {candidates.length === 0 ? (
              <div className="p-5 text-caption leading-5 text-ink-muted">
                <p>No replay candidate matches these filters.{filtered && <> <Link href="/replay" className="link-accent focus-ring underline">Clear filters</Link></>}</p>
              </div>
            ) : (
              <div>
                <div className="hidden grid-cols-[minmax(0,1.6fr)_120px_90px_minmax(0,1.4fr)_96px] gap-3 border-b border-line bg-surface-sunken px-4 py-2 text-ink-muted md:grid" aria-hidden="true">
                  <span className="label-caps">Target</span><span className="label-caps">Held-out opening</span><span className="label-caps">Precision</span><span className="label-caps">Latest backtest</span><span />
                </div>
                <ul className="divide-y divide-line text-caption" aria-label="Replay candidates, most recent held-out opening first">
                  {candidates.map((candidate) => {
                    const isSelected = selected?.key === candidate.key;
                    return (
                      <li key={candidate.key} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 md:grid-cols-[minmax(0,1.6fr)_120px_90px_minmax(0,1.4fr)_96px] ${isSelected ? "bg-surface-selected" : ""}`}>
                        <div className="min-w-0"><p className="font-semibold">{candidate.company}</p><p className="text-ink-muted">{candidate.role}</p></div>
                        <span className="col-span-2 row-start-2 flex flex-wrap items-center gap-2 tabular md:col-span-1 md:row-start-auto"><span className="md:hidden">Held out</span>{day(candidate.openedOn)}<span className="md:hidden"><PrecisionChip variant="code" precision={candidate.precision} /></span></span>
                        <span className="hidden md:block"><PrecisionChip variant="code" precision={candidate.precision} /></span>
                        <div className="col-span-2 row-start-3 md:col-span-1 md:row-start-auto"><OutcomeCell candidate={candidate} /></div>
                        <div className="col-start-2 row-start-1 text-right md:col-start-auto md:row-start-auto"><SelectButton candidate={candidate} selected={isSelected} onChoose={() => choose(candidate)} /></div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {summary.matching > REPLAY_PAGE_SIZE && (
              <nav className="flex items-center justify-between border-t border-line px-4 py-3 text-caption" aria-label="Replay candidate pages">
                {filters.page > 1 ? <Link href={replayHref(filters, { page: filters.page - 1 })} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1"><Icon name="chevron-left" size={13} />Previous</Link> : <span className="inline-flex items-center gap-1 text-ink-subtle" aria-hidden="true"><Icon name="chevron-left" size={13} />Previous</span>}
                <span className="tabular text-ink-muted">Page {Math.min(filters.page, pageCount)} of {pageCount}</span>
                {filters.page < pageCount ? <Link href={replayHref(filters, { page: filters.page + 1 })} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1">Next<Icon name="chevron-right" size={13} /></Link> : <span className="inline-flex items-center gap-1 text-ink-subtle" aria-hidden="true">Next<Icon name="chevron-right" size={13} /></span>}
              </nav>
            )}
          </section>

          {selected && (
            <section className="mt-5 panel" aria-labelledby="replay-controls-title">
              <div className="border-b border-line px-4 py-3"><h2 id="replay-controls-title" className="text-sm font-semibold">Choose the historical vantage point</h2><p className="mt-1 text-micro text-ink-muted">{selected.company} · {selected.role} · held out {day(selected.openedOn)} <PrecisionChip variant="code" precision={selected.precision} /></p></div>
              <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-end">
                <label className="block"><span className={labelClass}>Forecast cutoff</span><input type="date" value={cutoff} max={selected.openedOn} onChange={(event) => { setCutoff(event.target.value); setState({ status: "idle" }); }} className={fieldClass} /></label>
                <Button onClick={() => void run()} disabled={state.status === "running" || !apiConfigured} className={primaryButton}>{state.status === "running" ? <Icon name="loader-circle" size={14} className="animate-spin" /> : <Icon name="play" size={14} />}Run leak-free replay</Button>
              </div>
              {!apiConfigured && <p className="border-t border-line bg-warning-surface px-4 py-3 text-micro leading-4 text-warning-ink">The replay worker is not reachable from this deployment. Set FIRSTSEEN_AGENT_API_URL and AGENT_API_BEARER_TOKEN to run a replay.</p>}
            </section>
          )}
        </>}

        {state.status === "not_evaluable" && (
          <section className="panel mt-5 p-5" aria-label="Replay refused">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Icon name="lock-keyhole" size={15} className="text-ink-subtle" />Too little evidence was recorded before this cutoff to replay it</h2>
            <p className="mt-2 max-w-3xl text-caption leading-5 text-ink-muted">
              The leak-safe evaluator refused this case: <span className="font-medium">{state.reason}</span>
            </p>
            <p className="mt-2 max-w-3xl text-caption leading-5 text-ink-muted">
              Evidence is admitted only when both its date <em>and</em> the moment 1stSeen learned it precede
              the cutoff. Evidence collected today cannot forecast a past cycle, so an earlier cutoff can
              correctly admit nothing at all.
            </p>
          </section>
        )}

        {state.status === "error" && (
          <section className="mt-5 border border-warning-line bg-warning-surface p-5"><p className="flex items-center gap-2 text-xs font-semibold text-warning-ink"><Icon name="triangle-alert" size={14} />{state.message}</p></section>
        )}

        {result && <>
          <section className="mt-5 overflow-hidden panel" aria-labelledby="timeline-title">
            <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="label-caps text-accent-ink">Temporal boundary</p><h2 id="timeline-title" className="mt-1 text-sm font-semibold">What the model knew, predicted, and learned later</h2></div><span className="flex items-center gap-1.5 text-micro text-ink-muted"><Icon name="lock-keyhole" size={12} />cutoff enforced by the backtest · <span className="font-mono">{result.schema_version}</span></span></div>
            <div className="p-4 md:p-6"><div className="grid gap-5 md:grid-cols-[1fr_1.4fr_1fr]">
              <div className="border border-success-line bg-success-surface p-4"><p className="flex items-center gap-2 label-caps text-success-ink"><Icon name="clock-3" size={12} />Forecast cutoff</p><p className="mt-2 text-xl font-semibold tabular">{day(result.forecast_cutoff)}</p><p className="mt-1 text-micro text-ink-muted">Evidence gate closes at 23:59 UTC</p></div>
              <div className="border border-line bg-surface-sunken p-4"><div className="flex items-center justify-between gap-3"><div><p className="label-caps text-ink-subtle">Prediction made</p><p className="mt-2 text-xl font-semibold tabular">{day(result.interval_start)} – {day(result.interval_end)}</p><p className="mt-1 text-micro text-ink-muted">Expected {day(result.expected_opening_date)}</p>{resultBasis && <p className="mt-2"><ForecastBasisChip basis={resultBasis} variant="plain" /></p>}</div><ConfidenceIndicator value={result.confidence} compact /></div></div>
              <div className={`border p-4 ${showOutcome ? "border-success-line bg-success-surface" : "border-line bg-surface-sunken"}`}><div className="flex items-center justify-between"><p className="flex items-center gap-2 label-caps text-ink-subtle"><Icon name="target" size={12} />Later outcome</p><button type="button" onClick={() => setShowOutcome((value) => !value)} className="focus-ring -m-2 grid size-touch place-items-center rounded-control text-ink-muted hover:bg-surface-hover" aria-label={showOutcome ? "Hide later outcome" : "Reveal later outcome"}>{showOutcome ? <Icon name="eye" size={14} /> : <Icon name="eye-off" size={14} />}</button></div>{showOutcome ? <><p className="mt-2 text-xl font-semibold tabular">{day(result.actual_opened_on)}</p><p className={`mt-1 flex items-center gap-1.5 text-micro font-semibold ${result.inside_interval ? "text-success-ink" : "text-warning-ink"}`}>{result.inside_interval ? <Icon name="circle-check" size={12} /> : <Icon name="circle-slash" size={12} />}{result.inside_interval ? "Inside predicted interval" : "Outside predicted interval"}</p><p className="mt-1 text-micro text-ink-muted">actual interval {day(result.actual_interval_start)} – {day(result.actual_interval_end)} ({result.target_date_precision})</p></> : <><p className="mt-2 text-sm font-semibold">Outcome hidden</p><p className="mt-1 text-micro text-ink-muted">Reveal only after inspecting the forecast.</p></>}</div>
            </div></div>
          </section>

          <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
            <section className="panel" aria-labelledby="available-evidence-title">
              <div className="flex items-end justify-between border-b border-line px-4 py-3 md:px-5"><div><p className="label-caps text-accent-ink">Admitted inputs</p><h2 id="available-evidence-title" className="mt-1 text-sm font-semibold">Evidence available at the cutoff</h2></div><span className="text-micro tabular text-ink-muted">{result.evidence.length} record{result.evidence.length === 1 ? "" : "s"}</span></div>
              {result.evidence.length === 0 ? (
                <p className="p-5 text-xs leading-5 text-ink-muted">The cutoff admitted no evidence rows. Only hierarchical priors could contribute.</p>
              ) : (
                <div className="divide-y divide-line">{result.evidence.map((item) => <article key={item.id} className="grid gap-3 px-4 py-4 md:grid-cols-[24px_1fr_140px_92px] md:px-5"><span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-accent-soft text-success-ink" aria-hidden="true"><Icon name="check" size={11} /></span><div><div className="flex flex-wrap items-center gap-2"><SourceBadge kind={item.kind === "signal" ? "signal" : item.kind === "role_history" ? "archive" : "official"} label={kindLabel[item.kind] ?? item.kind} /></div><p className="mt-1 text-micro text-ink-subtle">Evidence date {day(item.evidence_on)}{item.uncertainty_days ? ` · ±${item.uncertainty_days} days uncertainty` : ""}</p><p className="mt-0.5 break-all font-mono text-micro text-ink-subtle">{item.id}</p></div><div><p className="label-caps text-ink-subtle">Available to 1stSeen</p><p className="mt-1 text-micro font-semibold tabular">{day(item.available_at)}</p></div><div className="md:text-right"><p className="text-xs font-semibold tabular">{Math.round(item.source_quality * 100)}%</p><p className="text-micro text-ink-subtle">source quality</p></div></article>)}</div>
              )}
            </section>

            <aside className="space-y-5">
              <section className="panel" aria-labelledby="score-title">
                <div className="border-b border-line px-4 py-3"><p className="label-caps text-warning-ink">Outcome scoring</p><h2 id="score-title" className="mt-1 text-sm font-semibold">Replay result</h2></div>
                <div className="grid grid-cols-2 border-b border-line"><div className="border-r border-line p-4"><p className="text-micro text-ink-subtle">Absolute date error</p><p className="mt-1 text-2xl font-semibold tabular">{result.absolute_error_days}<span className="ml-1 text-xs font-medium">days</span></p></div><div className="p-4"><p className="text-micro text-ink-subtle">Interval result</p><p className={`mt-1 flex items-center gap-1.5 text-sm font-semibold ${result.inside_interval ? "text-success-ink" : "text-warning-ink"}`}>{result.inside_interval ? <Icon name="circle-check" size={15} /> : <Icon name="circle-slash" size={15} />}{result.inside_interval ? "Covered" : "Missed"}</p></div></div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 p-4 text-micro"><dt className="text-ink-subtle">Forecast timestamp</dt><dd className="text-right tabular">{day(result.forecasted_at)}</dd><dt className="text-ink-subtle">Model</dt><dd className="break-all text-right font-mono">{result.model_version}</dd><dt className="text-ink-subtle">Input fingerprint</dt><dd className="truncate text-right font-mono" title={result.input_fingerprint}>{result.input_fingerprint.slice(0, 12)}…</dd></dl>
              </section>
              <section className="border border-success-line bg-success-surface p-4">
                <p className="flex items-center gap-2 text-xs font-semibold"><Icon name="lock-keyhole" size={14} className="text-success-ink" />Leakage checks on this result</p>
                <ul className="mt-3 space-y-2 text-micro leading-4 text-ink-muted">
                  {[
                    ["Held-out target absent from input IDs", !result.evidence.some((item) => item.id === result.target_event_id)],
                    ["All evidence dates are on or before cutoff", result.evidence.every((item) => item.evidence_on <= result.forecast_cutoff)],
                    ["All availability timestamps are on or before cutoff", result.evidence.every((item) => item.available_at.slice(0, 10) <= result.forecast_cutoff)],
                    ["Cutoff precedes the actual opening", result.forecast_cutoff < result.actual_opened_on],
                  ].map(([label, passed]) => (
                    <li key={String(label)} className="flex gap-2">
                      {passed ? <Icon name="check" size={11} className="mt-0.5 shrink-0 text-success-ink" /> : <Icon name="circle-slash" size={11} className="mt-0.5 shrink-0 text-warning-ink" />}
                      {label}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-micro leading-4 text-ink-subtle">Checks are evaluated against this returned result, not asserted in advance.</p>
              </section>
            </aside>
          </div>
        </>}

      </main>
    </div>
  );
}
