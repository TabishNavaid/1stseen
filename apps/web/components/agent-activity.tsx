import { Icon } from "@/components/ui/icon";
import { agentEvents } from "@/lib/demo-data";

export type AgentActivityView = {
  runId: string;
  status: string;
  startedAt: string;
  toolCount: number;
  /** Bounded count of traceable evidence records, from redacted tool output. */
  evidenceCount: number;
  durationMs: number;
  forecastReady: boolean;
  modelProvider: string | null;
  calls: { tool: string; summary: string; durationMs: number }[];
};

/**
 * Observable agent activity only.
 *
 * Every row comes from persisted `agent_tool_calls` redacted summaries. No
 * prompt, reasoning trace, or secret is ever surfaced here, and a null provider
 * is reported as "not required" rather than implying a model was called.
 */
export function AgentActivity({
  mode,
  activity = null,
}: {
  /** Required: a default of "demo" would let a caller that forgot it render fixtures. */
  mode: "real" | "demo" | "unconfigured";
  activity?: AgentActivityView | null;
}) {
  const demo = mode === "demo";
  const rows = demo
    ? agentEvents.slice(-5).map((event) => ({ tool: event.tool, summary: event.detail, durationMs: event.durationMs }))
    : (activity?.calls ?? []).slice(-5);
  const toolCount = demo ? agentEvents.length : activity?.toolCount ?? 0;
  const duration = demo
    ? agentEvents.reduce((total, event) => total + event.durationMs, 0)
    : activity?.durationMs ?? 0;
  const sourceCount = demo ? new Set(agentEvents.flatMap((event) => event.sourceIds)).size : 0;
  const evidenceCount = demo
    ? agentEvents.reduce((total, event) => total + event.evidenceAdded, 0)
    : activity?.evidenceCount ?? 0;
  const forecastReady = demo ? true : Boolean(activity?.forecastReady);

  return <section className="panel" aria-labelledby="agent-activity-title">
    <div className="flex items-center justify-between border-b border-line bg-surface-selected px-4 py-3"><div className="flex items-center gap-2"><Icon name="cpu" size={15} className="text-accent-ink" /><div><p className="label-caps text-accent-ink">Latest investigation</p><h2 id="agent-activity-title" className="mt-0.5 text-xs font-semibold">RecruitingAgent activity</h2></div></div><span className="flex items-center gap-1 text-micro text-ink-subtle"><Icon name="shield-check" size={12} />observable only</span></div>
    {rows.length === 0 ? (
      <p className="p-5 text-caption leading-5 text-ink-subtle">
        No agent run has been recorded in this deployment yet. Open a role and start an
        investigation to see its tool calls here.
      </p>
    ) : (
      <>
        <div className="grid grid-cols-4 border-b border-line bg-surface-sunken">
          {([["Tools", toolCount], ["Sources", demo ? sourceCount : "—"], ["Evidence", evidenceCount || "—"], ["Duration", `${duration} ms`]] as const).map(([label, value], index) => (
            <div key={label} className={`${index < 3 ? "border-r" : ""} border-line p-2.5`}>
              <p className="label-caps text-ink-subtle">{label}</p>
              <p className="mt-1 text-caption font-semibold tabular">{value}</p>
            </div>
          ))}
        </div>
        <div className="px-4">{rows.map((row, index) => <div key={`${row.tool}-${index}`} className="grid grid-cols-[18px_1fr_auto] gap-2 border-b border-line py-3 last:border-0"><span className="mt-0.5 grid h-4 w-4 place-items-center rounded-full bg-accent-soft text-accent-ink"><Icon name="check" size={10} /></span><div><p className="text-caption font-semibold text-ink-muted">{row.tool}</p><p className="mt-0.5 text-micro text-ink-subtle">{row.summary}</p></div><time className="text-micro tabular text-ink-subtle">{row.durationMs} ms</time></div>)}</div>
      </>
    )}
    <div className="flex items-center justify-between border-t border-line bg-surface-sunken px-4 py-2.5 text-micro text-ink-subtle"><span className="flex items-center gap-1"><Icon name="waypoints" size={11} />{forecastReady ? "Statistical forecast ready" : "No forecast produced"}</span><span>LLM provider · {demo ? "not required" : activity?.modelProvider ?? "not required"}</span></div>
  </section>;
}
