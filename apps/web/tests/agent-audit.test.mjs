/**
 * The dashboard's agent panel says "Statistical forecast ready" only when the run's forecast step returned a forecast.
 *
 * It compared the stored tool name `recruiting_agent.generate_forecast` with `generate_forecast`, so every run read as
 * "No forecast produced", and a presence test would call a refusal (too little history) ready.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { agentToolName, forecastProduced } from "../lib/agent-audit.ts";

test("a stored tool name is read as the bare tool name", () => {
  assert.equal(agentToolName("recruiting_agent.generate_forecast"), "generate_forecast");
  assert.equal(agentToolName("generate_forecast"), "generate_forecast");
  assert.equal(agentToolName("source_adapter.greenhouse"), "source_adapter.greenhouse");
});

test("the recorded flag decides, and a refusal is not a forecast", () => {
  assert.equal(forecastProduced("succeeded", { summary: "Loaded a stored forecast from the forecasting component.", forecast_produced: true }), true);
  assert.equal(forecastProduced("succeeded", { summary: "Not enough recorded history to forecast this role yet: one cycle", forecast_produced: false }), false);
});

test("rows written before the flag are read from the summary written only for a forecast", () => {
  assert.equal(forecastProduced("succeeded", { summary: "Loaded a statistically generated forecast from the forecasting component." }), true);
  assert.equal(forecastProduced("succeeded", { summary: "Not enough recorded history to forecast this role yet: one cycle" }), false);
  assert.equal(forecastProduced("failed", { summary: "Loaded a stored forecast from the forecasting component." }), false);
});
