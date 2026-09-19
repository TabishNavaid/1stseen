// How the dashboard reads a persisted RecruitingAgent run (agent_tool_calls, redacted). No imports, so node tests load it.

/** Audit rows name a tool `recruiting_agent.<tool>`; the stream and the panel use the bare tool name. */
export function agentToolName(stored: string): string {
  return stored.replace(/^recruiting_agent\./, "");
}

/**
 * Whether a recorded generate_forecast call returned a forecast. A refusal (too little history) is a succeeded call
 * with no forecast, so the call's presence or status cannot say it. The agent records `forecast_produced`; rows written
 * before it did are read from the summary the agent wrote only when a forecast came back ("Loaded a ... forecast").
 */
export function forecastProduced(status: string, output: Record<string, unknown>): boolean {
  if (typeof output.forecast_produced === "boolean") return output.forecast_produced;
  return status === "succeeded" && typeof output.summary === "string" && output.summary.startsWith("Loaded a ");
}
