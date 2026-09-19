/**
 * What the question panel tells a visitor when a question cannot be asked (lib/agent-availability.ts). A paused agent
 * service (the Cloud Run spend cap) must read as a temporary unavailability that leaves the rest of the site working,
 * never as an error page or an internal code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_UNAVAILABLE_MESSAGE,
  QUESTIONS_UNAVAILABLE_MESSAGE,
  REPLAY_UNAVAILABLE_MESSAGE,
  agentErrorMessage,
  agentErrorOffersSignUp,
  isAgentVerdict,
} from "../lib/agent-availability.ts";

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

test("only the agent service's own 4xx verdicts pass through; everything else reads as the service being unavailable", () => {
  // Its verdicts: a replay that cannot be scored leak-free, a role the member does not follow.
  assert.equal(isAgentVerdict(422, { error: "replay_not_evaluable", reason: "no evidence by the cutoff" }), true);
  assert.equal(isAgentVerdict(403, { error: "role_not_followed" }), true);
  // Google's front end answering for a paused service (HTML, so no JSON), a failing or throttled service, and the two
  // services disagreeing about their shared token.
  assert.equal(isAgentVerdict(403, null), false);
  assert.equal(isAgentVerdict(503, { error: "internal_error" }), false);
  assert.equal(isAgentVerdict(500, { error: "internal_error" }), false);
  assert.equal(isAgentVerdict(429, { error: "rate_limited" }), false);
  assert.equal(isAgentVerdict(401, { error: "unauthorized" }), false);
  assert.equal(isAgentVerdict(404, "not json"), false);
});

test("the member features say the same thing about a paused service as questions do", () => {
  for (const message of [REPLAY_UNAVAILABLE_MESSAGE, PLAN_UNAVAILABLE_MESSAGE]) {
    assert.match(message, /temporarily unavailable/);
    assert.match(message, /Forecasts, role pages, and their evidence still work\. Please try again later\.$/);
    assert.doesNotMatch(message, /error|failed|5\d\d|Cloud Run|spend|budget/i);
  }
});
