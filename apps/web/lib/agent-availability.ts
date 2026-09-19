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
