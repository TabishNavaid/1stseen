/**
 * What the question panel says when a question cannot be asked, and the sentence for a paused agent service.
 *
 * The agent API runs on Cloud Run under a monthly spend cap. When the cap is reached the service stops serving until the
 * next month or until the owner lifts it, and whatever Google's front end then answers (no response, or an error status)
 * is neither the visitor's fault nor theirs to fix. Everything else on the site reads the database directly and keeps
 * working, so the panel says exactly that, in place of an error. The agent route sends the same sentence with its 503.
 */
export const QUESTIONS_UNAVAILABLE_MESSAGE =
  "Asking questions is temporarily unavailable. Forecasts, role pages, and their evidence still work. Please try again later.";

/** The same sentence for the two member features that also need the agent service. */
export const REPLAY_UNAVAILABLE_MESSAGE =
  "Running a replay is temporarily unavailable. Forecasts, role pages, and their evidence still work. Please try again later.";
export const PLAN_UNAVAILABLE_MESSAGE =
  "Generating a preparation plan is temporarily unavailable. Forecasts, role pages, and their evidence still work. Please try again later.";

/**
 * Whether a failed answer from the agent service is its own verdict on the request, to pass on as it is, rather than
 * the service being unavailable. Its verdicts are JSON with an `error` and a 4xx status (a replay that cannot be scored
 * leak-free, a role the user does not follow). Anything else (no JSON, a 5xx, a 429, or a 401, which means the two
 * services disagree about their shared token) says the service cannot answer now, as a paused service does whether it
 * is silent or Google's front end answers for it with an error page.
 */
export function isAgentVerdict(status: number, payload: unknown): boolean {
  const error = typeof payload === "object" && payload !== null ? (payload as { error?: unknown }).error : undefined;
  return typeof error === "string" && status >= 400 && status < 500 && status !== 401 && status !== 429;
}

export type AgentErrorPayload = { error?: string; message?: string };

const SIGN_UP_ERRORS = new Set(["guest_rate_limited", "guest_agent_unavailable", "sign_in_required"]);

/** The sentence the question panel shows for a question the route refused or could not pass on. */
export function agentErrorMessage(payload: AgentErrorPayload): string {
  switch (payload.error) {
    case "guest_rate_limited":
    case "guest_agent_unavailable":
      return payload.message ?? "Questions without an account are limited right now.";
    case "sign_in_required":
      return "Your session has ended. Sign in again to ask the agent.";
    case "agent_api_unavailable":
      return "The RecruitingAgent service is not configured for this environment.";
    case "agent_api_unreachable":
    case "agent_api_failed":
      return QUESTIONS_UNAVAILABLE_MESSAGE;
    default:
      return "The investigation could not be started.";
  }
}

/** Whether the refusal is one an account would lift, so the panel offers sign-up beside it. */
export function agentErrorOffersSignUp(payload: AgentErrorPayload): boolean {
  return SIGN_UP_ERRORS.has(payload.error ?? "");
}
