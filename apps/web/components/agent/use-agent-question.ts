"use client";

import { useMemo, useState } from "react";
import { recruitingAgentProgressSchema, type RecruitingAgentProgress } from "@firstseen/shared";
import type { Outlook } from "@/components/likely-window";
import { agentErrorMessage, agentErrorOffersSignUp, type AgentErrorPayload } from "@/lib/agent-availability";
import type { IconName } from "@/components/ui/icon-names";

/**
 * Each step the RecruitingAgent can take, in the words a person reads. The stream names its tools; the page never does.
 */
export const AGENT_STEPS: ReadonlyArray<{ tool: NonNullable<RecruitingAgentProgress["tool"]>; label: string; icon: IconName }> = [
  { tool: "answer_portfolio_question", label: "Searched the programs we track", icon: "search" },
  { tool: "discover_company", label: "Found the company's job board", icon: "building-2" },
  { tool: "resolve_role", label: "Matched the program's past titles", icon: "git-merge" },
  { tool: "get_current_jobs", label: "Checked today's postings", icon: "briefcase-business" },
  { tool: "inspect_career_page", label: "Read the careers page", icon: "file-search" },
  { tool: "get_role_history", label: "Looked up past openings", icon: "clock-3" },
  { tool: "inspect_archives", label: "Checked archived copies", icon: "archive" },
  { tool: "get_recruiting_signals", label: "Looked for recruiting news", icon: "radar" },
  { tool: "generate_forecast", label: "Worked out the likely date", icon: "calendar-clock" },
  { tool: "get_forecast_evidence", label: "Checked every source behind it", icon: "shield-check" },
  { tool: "create_readiness_plan", label: "Built a prep plan", icon: "gauge" },
];

export type AgentStepState = "done" | "running" | "waiting" | "skipped";

function parseSseEvent(raw: string): RecruitingAgentProgress | null {
  const data = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!data) return null;
  try {
    // The stream crosses a trust boundary, so it is validated against the shared contract rather than cast. A malformed
    // event is dropped, not rendered.
    const parsed = recruitingAgentProgressSchema.safeParse(JSON.parse(data.slice(5).trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type ForecastData = { expected_opening_date?: string; interval_start?: string; interval_end?: string; confidence?: number };

/**
 * One question to the RecruitingAgent through /api/recruiting-agent, streamed. Only what the stream reports is shown:
 * the steps it took, its answer, and a forecast when the forecast step returned one; nothing is simulated.
 */
export function useAgentQuestion() {
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "error">("idle");
  const [events, setEvents] = useState<RecruitingAgentProgress[]>([]);
  const [error, setError] = useState("");
  const [signUp, setSignUp] = useState(false);

  async function ask(body: { question: string; context_company?: string; context_role?: string; context_role_id?: string }) {
    setStatus("running");
    setEvents([]);
    setError("");
    setSignUp(false);
    try {
      const response = await fetch("/api/recruiting-agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as AgentErrorPayload;
        if (agentErrorOffersSignUp(payload)) setSignUp(true);
        throw new Error(agentErrorMessage(payload));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failed = false;
      const take = (event: RecruitingAgentProgress | null) => {
        if (!event) return;
        if (event.type === "run_failed") failed = true;
        setEvents((current) => [...current, event]);
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) take(parseSseEvent(chunk));
        if (done) break;
      }
      take(parseSseEvent(buffer));
      if (failed) {
        setError("The check stopped before it could reach a responsible answer. Try again in a moment.");
        setStatus("error");
      } else {
        setStatus("complete");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The question could not be asked.");
      setStatus("error");
    }
  }

  const derived = useMemo(() => {
    const completed = new Map(events.filter((event) => event.type === "tool_completed" && event.tool).map((event) => [event.tool!, event]));
    const started = new Set(events.filter((event) => event.type === "tool_started" && event.tool).map((event) => event.tool!));
    const finalEvent = [...events].reverse().find((event) => event.type === "answer_completed");
    const answer = typeof finalEvent?.data?.answer === "string" ? finalEvent.data.answer : null;
    const forecast = completed.get("generate_forecast")?.data?.forecast as ForecastData | undefined;
    const outlook: Outlook | null = forecast?.expected_opening_date && forecast.interval_start && forecast.interval_end
      ? { expected: forecast.expected_opening_date, start: forecast.interval_start, end: forecast.interval_end }
      : null;
    const stateOf = (tool: string): AgentStepState =>
      completed.has(tool as never) ? "done" : started.has(tool as never) ? "running" : status === "complete" ? "skipped" : "waiting";
    const steps = AGENT_STEPS.map((step) => ({ ...step, state: stateOf(step.tool), note: completed.get(step.tool)?.message ?? null }));
    return { answer, outlook, confidence: typeof forecast?.confidence === "number" ? forecast.confidence : null, steps };
  }, [events, status]);

  return { status, error, signUp, ask, ...derived };
}
