"use client";

import Link from "next/link";
import { ConfidenceWord } from "@/components/confidence-word";
import { LikelyWindow } from "@/components/likely-window";
import { Icon } from "@/components/ui/icon";
import type { useAgentQuestion } from "@/components/agent/use-agent-question";
import { cn } from "@/lib/utils";

type Run = ReturnType<typeof useAgentQuestion>;

/**
 * What a question returned, in plain words: the answer, the likely date when the check produced one, and the steps it
 * took, each marked done, working, or not needed. Only the steps this kind of question can take are listed.
 */
export function AgentAnswer({ run, steps = "taken" }: { run: Run; steps?: "taken" | "all" }) {
  const shown = run.steps.filter((step) => steps === "all" || step.state !== "waiting" || run.status === "running")
    .filter((step) => steps === "all" || step.state !== "skipped");
  return (
    <div className="grid gap-4">
      {run.status === "running" && !run.answer && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Icon name="loader-circle" size={16} className="animate-spin" />Checking the evidence…</p>
      )}
      {run.answer && (
        <div className="rounded-card border border-accent bg-accent-soft p-5">
          <p className="label-caps text-accent-ink">Answer</p>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-ink">{run.answer}</p>
        </div>
      )}
      {run.outlook && run.confidence !== null && (
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-line bg-surface p-5">
          <LikelyWindow outlook={run.outlook} />
          <ConfidenceWord value={run.confidence} align="end" />
        </div>
      )}
      {run.error && (
        <p role="alert" className="flex items-start gap-2 rounded-card border border-warning-line bg-warning-surface px-4 py-3 text-sm text-warning-ink">
          <Icon name="circle-alert" size={16} className="mt-0.5 shrink-0" />
          <span>{run.error}{run.signUp && <> <Link href="/welcome" className="font-semibold underline">Get started free</Link></>}</span>
        </p>
      )}
      {shown.length > 0 && (
        <details className="group rounded-card border border-line bg-surface px-4 py-1" open={run.status === "running"}>
          <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-2 rounded-control text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
            What 1stSeen checked
            <Icon name="chevron-down" size={14} className="text-ink-subtle transition-transform group-open:rotate-180" />
          </summary>
          <ol className="grid gap-2 pb-3 pt-1">
            {shown.map((step) => (
              <li key={step.tool} className="flex items-start gap-3">
                <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", step.state === "done" ? "bg-accent text-ink-inverse" : step.state === "running" ? "bg-accent-soft text-accent-ink" : "bg-surface-sunken text-ink-subtle")} aria-hidden="true">
                  <Icon name={step.state === "done" ? "check" : step.state === "running" ? "loader-circle" : step.icon} size={13} className={step.state === "running" ? "animate-spin" : undefined} />
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-sm", step.state === "skipped" || step.state === "waiting" ? "text-ink-subtle" : "font-semibold text-ink")}>{step.label}</span>
                  <span className="sr-only">{step.state === "done" ? "Done." : step.state === "running" ? "Working." : step.state === "skipped" ? "Not needed." : "Waiting."}</span>
                  {step.note && <span className="block text-caption text-ink-muted">{step.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
