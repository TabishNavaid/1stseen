/**
 * What the question panel tells a visitor when a question cannot be asked (lib/agent-availability.ts). A paused agent
 * service (the Cloud Run spend cap) must read as a temporary unavailability that leaves the rest of the site working,
 * never as an error page or an internal code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUESTIONS_UNAVAILABLE_MESSAGE, agentErrorMessage, agentErrorOffersSignUp } from "../lib/agent-availability.ts";

test("an unreachable or failing agent service reads as questions being temporarily unavailable", () => {
  for (const error of ["agent_api_unreachable", "agent_api_failed"]) {
    assert.equal(agentErrorMessage({ error }), QUESTIONS_UNAVAILABLE_MESSAGE, error);
    assert.equal(agentErrorOffersSignUp({ error }), false, `${error}: an account would not help`);
  }
  assert.match(QUESTIONS_UNAVAILABLE_MESSAGE, /temporarily unavailable/);
  assert.match(QUESTIONS_UNAVAILABLE_MESSAGE, /Forecasts, role pages, and their evidence still work/);
  assert.doesNotMatch(QUESTIONS_UNAVAILABLE_MESSAGE, /error|failed|5\d\d|Cloud Run|spend|budget/i);
});

test("the other refusals keep their own sentences, and only the guest ones offer an account", () => {
  assert.equal(agentErrorMessage({ error: "guest_rate_limited", message: "Wait a minute." }), "Wait a minute.");
  assert.equal(agentErrorOffersSignUp({ error: "guest_rate_limited" }), true);
  assert.equal(agentErrorMessage({ error: "sign_in_required" }), "Your session has ended. Sign in again to ask the agent.");
  assert.equal(agentErrorMessage({ error: "agent_api_unavailable" }), "The RecruitingAgent service is not configured for this environment.");
  assert.equal(agentErrorMessage({}), "The investigation could not be started.");
});
