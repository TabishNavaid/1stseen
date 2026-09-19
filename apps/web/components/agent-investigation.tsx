"use client";

import { AgentAnswer } from "@/components/agent/agent-answer";
import { useAgentQuestion } from "@/components/agent/use-agent-question";
import { Icon } from "@/components/ui/icon";

/**
 * "Check the latest evidence" on a role page: asks the RecruitingAgent about this program, with the role itself as
 * context (its id, so a title two programs share still resolves to this one), and shows what the stream reports as it
 * happens. It never simulates a step or a result.
 */
export function AgentInvestigation({ company, role, roleId }: { company: string; role: string; roleId?: string }) {
  const run = useAgentQuestion();
  const busy = run.status === "running";

  function check() {
    void run.ask({
      question: `Investigate ${company} ${role}. Identify the recruiting system, check current postings and the career page, retrieve historical cycles, inspect archives, resolve role aliases, collect recruiting signals, generate the statistical forecast, verify its evidence, and calculate the readiness timeline.`,
      context_company: company,
      context_role: role,
      ...(roleId ? { context_role_id: roleId } : {}),
    });
  }

  return (
    <section className="card overflow-hidden" aria-labelledby="agent-investigation-title">
      <div className="flex flex-col gap-4 border-b border-line bg-accent-soft p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 id="agent-investigation-title" className="text-lg font-semibold tracking-title">Check the latest evidence</h2>
          <p className="mt-1 max-w-2xl text-caption leading-5 text-ink-muted">1stSeen looks again at the postings, the past openings, and any recruiting news for this program, and lists each step as it goes.</p>
        </div>
        <button type="button" onClick={check} disabled={busy} className="focus-ring inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-chip bg-accent px-5 text-sm font-semibold text-ink-inverse hover:bg-accent-hover disabled:opacity-70">
          {busy ? <Icon name="loader-circle" size={15} className="animate-spin" /> : <Icon name="search-check" size={15} />}
          {run.status === "complete" ? "Check again" : "Check now"}
        </button>
      </div>
      <div className="p-5">
        {run.status === "idle" ? (
          <details className="group">
            <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 rounded-control text-sm font-semibold text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
              What it checks, in order
              <Icon name="chevron-down" size={14} className="transition-transform group-open:rotate-180" />
            </summary>
            <ol className="mt-2 grid gap-2 sm:grid-cols-2">
              {run.steps.filter((step) => step.tool !== "answer_portfolio_question").map((step) => (
                <li key={step.tool} className="flex items-center gap-2.5 text-sm text-ink-muted">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-ink-subtle" aria-hidden="true"><Icon name={step.icon} size={13} /></span>
                  {step.label}
                </li>
              ))}
            </ol>
          </details>
        ) : (
          <AgentAnswer run={run} />
        )}
      </div>
    </section>
  );
}
