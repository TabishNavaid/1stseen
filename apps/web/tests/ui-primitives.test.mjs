/**
 * UI primitives: the keyboard and validation logic, and the accessibility wiring each primitive renders.
 *
 * The logic modules are plain TypeScript and run here directly. The wiring is read from the built Worker's
 * /design-system page, which renders every primitive under the development gate (FIRSTSEEN_DEMO_MODE=true and no
 * database) and is a 404 otherwise. Interactive behavior was also verified by keyboard in a browser.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { dateRangeMessage, dateRangeProblem, isIsoDate } from "../lib/ui/date-range.ts";
import { filterOptions, nextIndex, resultAnnouncement } from "../lib/ui/listbox.ts";

const OPTIONS = [
  { value: "a", label: "Software Engineering Intern", description: "Internship" },
  { value: "b", label: "Quantitative Researcher", description: "New grad" },
  { value: "c", label: "Désigner, Product", description: "Internship" },
];

test("filterOptions matches every word, ignoring case, accents, and order", () => {
  assert.deepEqual(filterOptions(OPTIONS, "").map((option) => option.value), ["a", "b", "c"]);
  assert.deepEqual(filterOptions(OPTIONS, "intern software").map((option) => option.value), ["a"]);
  assert.deepEqual(filterOptions(OPTIONS, "DESIGNER").map((option) => option.value), ["c"]);
  assert.deepEqual(filterOptions(OPTIONS, "new grad").map((option) => option.value), ["b"]);
  assert.deepEqual(filterOptions(OPTIONS, "robotics"), []);
});

test("nextIndex holds at the ends of a listbox and wraps in tabs", () => {
  assert.equal(nextIndex(-1, "ArrowDown", 3, false), 0);
  assert.equal(nextIndex(-1, "ArrowUp", 3, false), 2);
  assert.equal(nextIndex(2, "ArrowDown", 3, false), 2);
  assert.equal(nextIndex(0, "ArrowUp", 3, false), 0);
  assert.equal(nextIndex(2, "ArrowRight", 3, true), 0);
  assert.equal(nextIndex(0, "ArrowLeft", 3, true), 2);
  assert.equal(nextIndex(1, "Home", 3, true), 0);
  assert.equal(nextIndex(1, "End", 3, false), 2);
  assert.equal(nextIndex(0, "ArrowDown", 0, false), -1);
});

test("resultAnnouncement counts results and states the empty message", () => {
  assert.equal(resultAnnouncement(0, "No company matches"), "No company matches");
  assert.equal(resultAnnouncement(1, "x"), "1 result");
  assert.equal(resultAnnouncement(4, "x"), "4 results");
});

test("date ranges accept open ends and name the first problem", () => {
  assert.equal(isIsoDate("2026-02-28"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("02/28/2026"), false);
  assert.equal(dateRangeProblem("", ""), null);
  assert.equal(dateRangeProblem("2026-01-01", ""), null);
  assert.equal(dateRangeProblem("", "2026-01-01"), null);
  assert.equal(dateRangeProblem("2026-03-01", "2026-02-01"), "end_before_start");
  assert.equal(dateRangeProblem("2026-13-01", ""), "start_invalid");
  assert.equal(dateRangeProblem("2025-12-01", "", { min: "2026-01-01" }), "before_min");
  assert.equal(dateRangeProblem("", "2027-01-02", { max: "2027-01-01" }), "after_max");
  assert.equal(dateRangeMessage("end_before_start"), "The end date is before the start date.");
  assert.equal(dateRangeMessage("before_min", { min: "2026-01-01" }), "Dates must be on or after 2026-01-01.");
});

async function render(pathname, env = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    return await worker.fetch(
      new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const tags = (html, pattern) => [...html.matchAll(new RegExp(`<[a-z]+\\b[^>]*${pattern}[^>]*>`, "g"))].map((match) => match[0]);
const hasId = (html, id) => html.includes(`id="${id}"`);

test("the design-system page is a 404 outside the development gate", async () => {
  assert.equal((await render("/design-system", { FIRSTSEEN_DEMO_MODE: "" })).status, 404);
  const withDatabase = await render("/design-system", {
    FIRSTSEEN_DEMO_MODE: "true",
    SUPABASE_URL: "http://127.0.0.1:9",
    SUPABASE_SERVICE_ROLE_KEY: "integration-test-placeholder-not-a-key",
  });
  assert.equal(withDatabase.status, 404);
});

test("every primitive renders its accessible names, roles, and references", async () => {
  const response = await render("/design-system", { FIRSTSEEN_DEMO_MODE: "true" });
  assert.equal(response.status, 200);
  const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

  for (const input of tags(html, 'class="control')) {
    const id = attribute(input, "id");
    if (!id || attribute(input, "type") === "hidden") continue;
    assert.ok(html.includes(`for="${id}"`), `control ${id} has a label`);
  }

  const [combobox] = tags(html, 'role="combobox"');
  assert.ok(combobox, "a combobox renders");
  assert.equal(attribute(combobox, "aria-expanded"), "false");
  assert.equal(attribute(combobox, "aria-autocomplete"), "list");
  assert.ok(hasId(html, attribute(combobox, "aria-controls")), "combobox controls its listbox");
  assert.ok(tags(html, 'role="listbox"').length > 0);
  // A collapsed list renders no options; they are rendered when it opens (verified by keyboard in the browser).
  assert.equal(tags(html, 'role="option"').length, 0);

  const tabs = tags(html, 'role="tab"');
  assert.ok(tabs.length >= 2, "tabs render");
  assert.equal(tabs.filter((tab) => attribute(tab, "aria-selected") === "true").length, 1);
  assert.deepEqual(tabs.map((tab) => attribute(tab, "tabindex") === "0"), tabs.map((tab) => attribute(tab, "aria-selected") === "true"), "only the selected tab is in the tab order");
  for (const tab of tabs) assert.ok(hasId(html, attribute(tab, "aria-controls")), "each tab controls a panel");
  assert.ok(tags(html, 'role="tablist"').every((list) => attribute(list, "aria-label")));

  for (const trigger of tags(html, "aria-describedby=")) {
    for (const id of attribute(trigger, "aria-describedby").split(" ")) assert.ok(hasId(html, id), `description ${id} exists`);
  }
  assert.ok(tags(html, 'role="tooltip"').length > 0, "a tooltip renders");

  const [popoverButton] = tags(html, "aria-expanded=").filter((tag) => tag.startsWith("<button"));
  assert.ok(popoverButton, "a popover button renders");
  assert.ok(hasId(html, attribute(popoverButton, "aria-controls")));

  assert.match(html, /<dialog\b[^>]*aria-labelledby="[^"]+"/);
  assert.match(html, /<fieldset[\s\S]*?<legend[^>]*>Opening window<\/legend>/);
  assert.match(html, /<fieldset[\s\S]*?<legend[^>]*>Track<\/legend>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-label="Remove [^"]+"/);
  assert.match(html, /role="status" aria-busy="true"/);
  assert.match(html, /<h3[^>]*>No roles match these filters<\/h3>/);
});
