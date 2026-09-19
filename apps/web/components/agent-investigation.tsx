"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { recruitingAgentProgressSchema, type RecruitingAgentProgress } from "@firstseen/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { confidenceOutOf } from "@/lib/confidence";
import { forecastBasis } from "@/lib/forecast-basis";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { formatDay } from "@/lib/dates";
import { agentErrorMessage, agentErrorOffersSignUp, type AgentErrorPayload } from "@/lib/agent-availability";

type ProgressItem = RecruitingAgentProgress;

type ForecastSummary = {
  expected_opening_date?: string;
  interval_start?: string;
  interval_end?: string;
  confidence?: number;
  model_version?: string;
  cached?: boolean;
  own_history_weight?: number;
  borrowed_weight?: number;
};

const stages = [
  { tool: "discover_company", label: "Identified recruiting system", description: "Matched the company and stored ATS identity.", icon: "database" as const },
  { tool: "resolve_role", label: "Resolved role aliases", description: "Applied persisted aliases and compatibility rules.", icon: "git-merge" as const },
  { tool: "get_current_jobs", label: "Checked current postings", description: "Inspected normalized current job observations.", icon: "briefcase-business" as const },
  { tool: "inspect_career_page", label: "Inspected career evidence", description: "Checked the latest stored career-page record.", icon: "file-search" as const },
  { tool: "get_role_history", label: "Retrieved historical cycles", description: "Loaded source-backed recurring opening events.", icon: "clock-3" as const },
  { tool: "inspect_archives", label: "Inspected archived evidence", description: "Reviewed relevant captures and uncertainty.", icon: "archive" as const },
  { tool: "get_recruiting_signals", label: "Collected recruiting signals", description: "Loaded current supporting signals and reliability.", icon: "radar" as const },
  { tool: "generate_forecast", label: "Generated statistical forecast", description: "Delegated dates and confidence to the forecast model.", icon: "waypoints" as const },
  { tool: "get_forecast_evidence", label: "Verified forecast evidence", description: "Confirmed traceable contributions and sources.", icon: "shield-check" as const },
  { tool: "create_readiness_plan", label: "Calculated readiness timeline", description: "Worked backward through the deterministic policy.", icon: "gauge" as const },
] as const;

function parseSseEvent(raw: string): ProgressItem | null {
  const data = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!data) return null;
  try {
    // The stream crosses a trust boundary, so it is validated against the shared
    // contract rather than cast. A malformed event is dropped, not rendered.
    const parsed = recruitingAgentProgressSchema.safeParse(JSON.parse(data.slice(5).trim()));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function numeric(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return typeof value === "number" ? value : 0;
}

function formatDuration(milliseconds: number) {
  if (!milliseconds) return "—";
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatDate(value?: string) {
  return value ? formatDay(value) : "—";
}

export function AgentInvestigation({ company, role, roleId }: { company: string; role: string; roleId?: string }) {
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "error">("idle");
  const [events, setEvents] = useState<ProgressItem[]>([]);
  const [error, setError] = useState("");
  // Guest limits and an ended session point to an account rather than just failing.
  const [signUp, setSignUp] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);

  async function investigate() {
    setStatus("running"); setEvents([]); setError(""); setSignUp(false); setToolsOpen(true);
    try {
      const response = await fetch("/api/recruiting-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: `Investigate ${company} ${role}. Identify the recruiting system, check current postings and the career page, retrieve historical cycles, inspect archives, resolve role aliases, collect recruiting signals, generate the statistical forecast, verify its evidence, and calculate the readiness timeline.`,
          context_company: company,
          context_role: role,
          ...(roleId ? { context_role_id: roleId } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as AgentErrorPayload;
        if (agentErrorOffersSignUp(payload)) setSignUp(true);
        throw new Error(agentErrorMessage(payload));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawFailure = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const event = parseSseEvent(chunk);
          if (event) {
            if (event.type === "run_failed") sawFailure = true;
            setEvents((current) => [...current, event]);
          }
        }
        if (done) break;
      }
      const finalEvent = parseSseEvent(buffer);
      if (finalEvent) {
        if (finalEvent.type === "run_failed") sawFailure = true;
        setEvents((current) => [...current, finalEvent]);
      }
      if (sawFailure) {
        setError("The evidence review stopped before a responsible conclusion was available.");
        setStatus("error");
      } else {
        setStatus("complete");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The investigation stopped unexpectedly.");
      setStatus("error");
    }
  }

  const completedTools = useMemo(() => new Map(events.filter((event) => event.type === "tool_completed" && event.tool).map((event) => [event.tool!, event])), [events]);
  const startedTools = useMemo(() => new Set(events.filter((event) => event.type === "tool_started" && event.tool).map((event) => event.tool!)), [events]);
  const finalEvent = [...events].reverse().find((event) => event.type === "answer_completed");
  const forecastEvent = completedTools.get("generate_forecast");
  const forecast = forecastEvent?.data?.forecast as ForecastSummary | undefined;
  const basis = typeof forecast?.own_history_weight === "number" && typeof forecast?.borrowed_weight === "number"
    ? forecastBasis(forecast.own_history_weight, forecast.borrowed_weight)
    : null;
  const toolCount = completedTools.size;
  const evidenceCount = Math.max(0, ...events.map((event) => numeric(event.data, "evidence_count")));
  const sourceCount = Math.max(0, ...events.map((event) => numeric(event.data, "source_count")));
  const duration = numeric(finalEvent?.data, "duration_ms") || (() => {
    const times = events.map((event) => event.timestamp ? Date.parse(event.timestamp) : NaN).filter(Number.isFinite);
    return times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  })();
  const provider = events.find((event) => typeof event.data?.model_provider === "string")?.data?.model_provider as string | undefined;
  const answer = typeof finalEvent?.data?.answer === "string" ? finalEvent.data.answer : null;
  const recruitingSystem = completedTools.get("discover_company")?.data?.recruiting_system;

  const statusText = status === "running" ? "Investigation running" : status === "complete" ? "Evidence review complete" : status === "error" ? "Needs attention" : "Ready to investigate";
  const statusStyle = status === "running" ? "border-line-strong bg-surface text-accent-ink" : status === "complete" ? "border-success-line bg-success-surface text-success-ink" : status === "error" ? "border-warning-line bg-warning-surface text-warning-ink" : "border-line bg-surface-sunken text-ink-muted";
  const dotStyle = status === "running" ? "animate-pulse bg-focus" : status === "complete" ? "bg-success-line" : status === "error" ? "bg-warning-line" : "bg-line-strong";

  const sequence = <ol className="mt-4 grid gap-2 sm:grid-cols-2">{stages.map((stage) => {
    const completed = completedTools.get(stage.tool);
    const running = startedTools.has(stage.tool) && !completed;
    const skipped = status === "complete" && !completed;
    const label = stage.tool === "generate_forecast" && forecast?.cached ? "Loaded current statistical forecast" : stage.label;
    const state = completed ? formatDuration(numeric(completed.data, "duration_ms")) : running ? "live" : skipped ? "skipped" : "queued";
    return <li key={stage.tool} className={cn("grid grid-cols-[30px_minmax(0,1fr)_auto] gap-2 border p-3 transition-colors", completed ? "border-success-line bg-success-surface" : running ? "border-line-strong bg-surface-selected" : "border-line bg-surface")}><span className={cn("grid h-7 w-7 place-items-center rounded-full", completed ? "bg-accent-soft text-success-ink" : running ? "bg-accent text-ink-inverse" : "bg-surface-sunken text-ink-subtle")} aria-hidden="true">{completed ? <Icon name="check" size={13} /> : running ? <Icon name="loader-circle" size={13} className="animate-spin" /> : <Icon name={stage.icon} size={13} />}</span><div className="min-w-0"><p className={cn("text-caption font-semibold", skipped ? "text-ink-subtle" : "text-ink")}>{label}</p><p className="mt-0.5 text-micro text-ink-subtle">{completed?.message ?? (skipped ? "Not required for this run." : stage.description)}</p></div><span className="label-caps pt-0.5 text-ink-subtle">{state}</span></li>;
  })}</ol>;

  return <section className="overflow-hidden border border-success-line bg-surface" aria-labelledby="agent-investigation-title">
    <div className="grid gap-4 border-b border-line bg-success-surface p-4 md:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="label-caps flex items-center gap-1.5 text-success-ink"><Icon name="sparkles" size={12} />Agent investigation</p>
          <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-micro font-semibold", statusStyle)}><span className={cn("h-1.5 w-1.5 rounded-full", dotStyle)} aria-hidden="true" />{statusText}</span>
        </div>
        <h2 id="agent-investigation-title" className="mt-2 text-lg font-semibold tracking-title">Watch the agent operate over tools and evidence</h2>
        <p className="mt-1 max-w-2xl text-caption text-ink-muted">Each step is a tool the agent ran and what it returned.</p>
      </div>
      <Button onClick={investigate} disabled={status === "running"} className="min-h-touch shrink-0 gap-2">{status === "running" ? <Icon name="loader-circle" size={14} className="animate-spin" /> : <Icon name="search-check" size={14} />}{status === "complete" ? "Run again" : "Investigate with 1stSeen Agent"}</Button>
    </div>

    {status === "idle" ? (
      <details className="group border-b border-line px-4 py-1 md:px-5">
        <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-ink-muted hover:text-ink">
          <span>What the agent checks, in order ({stages.length} steps)</span>
          <Icon name="chevron-down" size={14} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="pb-4">{sequence}</div>
      </details>
    ) : (
      <>
        <dl className="grid grid-cols-2 border-b border-line bg-surface-sunken sm:grid-cols-3 lg:grid-cols-6">{[
          ["Tool calls", toolCount || "—"],
          ["Sources", sourceCount || "—"],
          ["Evidence", evidenceCount || "—"],
          ["Duration", formatDuration(duration)],
          ["Forecast", forecast ? (forecast.cached ? "Current loaded" : "Generated") : "—"],
          ["Model provider", provider ?? "Not required"],
        ].map(([label, value], index) => <div key={label} className={cn("border-line p-3", index % 2 === 0 && "border-r", index < 4 && "border-b sm:border-b-0", index < 5 && "lg:border-r")}><dt className="label-caps text-ink-subtle">{label}</dt><dd className="mt-1 text-xs font-semibold tabular text-ink">{value}</dd></div>)}</dl>

        <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,.85fr)]">
          <div className="border-b border-line p-4 md:p-5 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="label-caps text-ink-subtle">Investigation sequence</p><h3 className="mt-1 text-sm font-semibold">From identity to action plan</h3></div>{typeof recruitingSystem === "string" && <span className="rounded-chip border border-source-official-line bg-source-official-surface px-2 py-0.5 text-micro font-semibold text-source-official-ink">ATS · {recruitingSystem}</span>}</div>
            {sequence}
          </div>
          <div className="p-4 md:p-5">
            <div className="flex items-center justify-between"><div><p className="label-caps text-ink-subtle">Run output</p><h3 className="mt-1 text-sm font-semibold">Forecast and evidence</h3></div><Icon name="cpu" size={16} className="text-accent-ink" /></div>
            {forecast ? <div className="mt-4"><div className="border border-success-line bg-success-surface p-4"><p className="label-caps text-success-ink">Statistical forecast ready</p><p className="mt-2 text-xl font-semibold tracking-title tabular">{formatDate(forecast.interval_start)} – {formatDate(forecast.interval_end)}</p><dl className="mt-3 grid grid-cols-2 gap-3 border-t border-success-line/40 pt-3"><div><dt className="text-micro text-ink-subtle">Expected opening</dt><dd className="mt-1 text-xs font-semibold tabular">{formatDate(forecast.expected_opening_date)}</dd></div><div><dt className="text-micro text-ink-subtle">Confidence score</dt><dd className="mt-1 text-xs font-semibold tabular">{forecast.confidence === undefined ? "—" : confidenceOutOf(forecast.confidence, 1)}</dd></div></dl>{basis && <p className="mt-3"><ForecastBasisChip basis={basis} /></p>}<p className="mt-3 break-all font-mono text-micro text-ink-subtle">{forecast.model_version}</p></div>{answer && <div className="mt-3 border-l-2 border-success-line pl-3"><p className="label-caps text-ink-subtle">Evidence-backed conclusion</p><p className="mt-1 line-clamp-6 text-caption text-ink-muted">{answer}</p></div>}</div> : <div className="mt-4 grid min-h-[160px] place-items-center border border-dashed border-line-strong bg-surface-sunken p-6 text-center"><div><Icon name="circle-dashed" size={24} className="mx-auto text-ink-subtle" /><p className="mt-3 text-xs font-semibold">{status === "running" ? "Waiting for the forecast step" : "No forecast in this run"}</p><p className="mt-1 max-w-xs text-micro text-ink-subtle">Sourced evidence counts, the forecast-model result, and readiness output appear here as the tools report them.</p></div></div>}
          </div>
        </div>
      </>
    )}

    {(events.length > 0 || error) && <div className="border-t border-line bg-surface-sunken"><button type="button" onClick={() => setToolsOpen((open) => !open)} aria-expanded={toolsOpen} className="focus-ring flex min-h-touch w-full items-center justify-between px-4 py-2 text-left md:px-5"><span><span className="label-caps text-ink-subtle">Tool-call ledger</span><span className="ml-2 text-micro text-ink-subtle">{toolCount} completed · observable summaries only</span></span>{toolsOpen ? <Icon name="chevron-up" size={14} /> : <Icon name="chevron-down" size={14} />}</button>{toolsOpen && <div className="border-t border-line px-4 pb-4 md:px-5"><ol className="divide-y divide-line">{events.filter((event) => event.type === "tool_completed").map((event, index) => <li key={`${event.tool}-${index}`} className="grid gap-2 py-3 sm:grid-cols-[24px_170px_minmax(0,1fr)_auto]"><span className="grid h-5 w-5 place-items-center rounded-full bg-accent-soft text-success-ink" aria-hidden="true"><Icon name="check" size={11} /></span><code className="break-all font-mono text-micro text-ink-muted">{event.tool}</code><p className="text-micro text-ink-muted">{event.message}</p><span className="text-micro tabular text-ink-subtle">{numeric(event.data, "result_count")} result{numeric(event.data, "result_count") === 1 ? "" : "s"} · {formatDuration(numeric(event.data, "duration_ms"))}</span></li>)}</ol>{events.find((event) => event.type === "evidence_assessed") && <p className="mt-2 flex items-center gap-2 border-l-2 border-success-line bg-success-surface px-3 py-2 text-micro text-success-ink"><Icon name="shield-check" size={13} />{events.find((event) => event.type === "evidence_assessed")?.message}</p>}{error && <p role="alert" className="mt-3 flex items-start gap-2 border-l-2 border-warning-line bg-warning-surface px-3 py-2 text-caption text-warning-ink"><Icon name="circle-alert" size={14} className="mt-0.5" /><span>{error}{signUp && <> <Link href="/signin?mode=sign_up" className="font-semibold underline">Create an account</Link></>}</span></p>}</div>}</div>}
  </section>;
}
