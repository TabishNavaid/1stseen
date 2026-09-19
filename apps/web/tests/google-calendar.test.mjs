import assert from "node:assert/strict";
import test from "node:test";
import {
  mapSelectedEvent,
  syncSelectedEvent,
} from "../lib/google-calendar/events.ts";

const forecast = {
  sourceKey: "northstar-window-start",
  eventType: "predicted_start",
  date: "2026-09-04",
  company: "Northstar",
  role: "Software Engineering Intern",
  label: "Predicted window starts",
  detail: "Start of a statistical interval.",
  confidence: 71,
  roleUrl: "https://firstseen.example/roles/northstar-swe-intern",
};

test("forecast mapping is visibly predictive and uses an exclusive all-day end", async () => {
  const event = await mapSelectedEvent(forecast, "00000000-0000-4000-8000-000000000001");
  assert.match(event.summary, /^1stSeen forecast:/);
  assert.match(event.description, /not a confirmed company date/i);
  assert.match(event.description, /Forecast confidence score 71 of 100: how much consistent evidence backs the window, not the chance it is right\./);
  assert.doesNotMatch(event.description, /%/, "a confidence score is never written as a percentage");
  assert.equal(event.start.date, "2026-09-04");
  assert.equal(event.end.date, "2026-09-05");
  assert.match(event.id, /^1stseen[a-f0-9]{48}$/);
});

test("identical retry is idempotent and does not write to Google twice", async () => {
  const mappings = new Map();
  let inserts = 0;
  let updates = 0;
  const operations = {
    find: async (key, kind) => mappings.get(`${kind}:${key}`) ?? null,
    insert: async () => { inserts += 1; },
    update: async () => { updates += 1; },
    save: async (mapping) => { mappings.set(`${mapping.sourceKind}:${mapping.sourceKey}`, mapping); },
  };
  const first = await syncSelectedEvent(forecast, "user-1", operations);
  const retry = await syncSelectedEvent(forecast, "user-1", operations);
  assert.equal(first.action, "created");
  assert.equal(retry.action, "unchanged");
  assert.equal(inserts, 1);
  assert.equal(updates, 0);
});

test("changed forecast updates the persisted Google event instead of inserting", async () => {
  const mappings = new Map();
  let inserts = 0;
  const updatedIds = [];
  const operations = {
    find: async (key, kind) => mappings.get(`${kind}:${key}`) ?? null,
    insert: async () => { inserts += 1; },
    update: async (id) => { updatedIds.push(id); },
    save: async (mapping) => { mappings.set(`${mapping.sourceKind}:${mapping.sourceKey}`, mapping); },
  };
  const created = await syncSelectedEvent(forecast, "user-2", operations);
  const changed = await syncSelectedEvent({ ...forecast, date: "2026-09-06", confidence: 66 }, "user-2", operations);
  assert.equal(changed.action, "updated");
  assert.equal(inserts, 1);
  assert.deepEqual(updatedIds, [created.googleEventId]);
  assert.equal(changed.googleEventId, created.googleEventId);
});
