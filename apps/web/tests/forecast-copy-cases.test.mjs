/**
 * What a forecast is called depends on where today falls in its window (FORECAST_COPY_CASES.md).
 *
 * The case that matters is the last one: the expected date has gone by and no posting has been seen. Rendering that
 * as "Likely around" puts a past date under a future-tense label, which reads as a date still to come.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { outlookLabel, outlookNote, windowState } from "../lib/forecast-window.ts";

const WINDOW = { expected: "2027-07-17", start: "2027-06-20", end: "2027-08-14" };

async function render(pathname, env = { FIRSTSEEN_DEMO_MODE: "true" }) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return await response.text();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Each row of the list, as words. */
function rows(html) {
  return [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g)]
    .map(([, inner]) => inner.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

test("a live posting outranks the forecast: an open programme says so and does not guess at a date", async () => {
  const html = await render("/roles");
  const listed = rows(html).filter((row) => row.includes("Open now"));
  assert.ok(listed.length > 0, "the fixtures include an open programme, because almost every real one is");
  for (const row of listed) {
    // The question a forecast answers is already answered while the posting is up.
    assert.doesNotMatch(row, /Likely around|Expected around|Not seen open yet/, row.slice(0, 90));
    assert.match(row, /Applications are open/);
    // The forecast is not gone, it moved: the drawer is where the window now lives.
    assert.match(row, /See the forecast/);
    // The confidence belongs to the forecast, so it goes with it.
    assert.doesNotMatch(row, /confidence/i);
  }
  // And the fact is no longer the last item of the small meta line under the title.
  assert.doesNotMatch(html, /Hybrid · Open now|On-site · Open now|Program year \d+ · Open now/);
});

test("a programme with no posting keeps its forecast as the loud thing", async () => {
  const html = await render("/roles");
  const quiet = rows(html).filter((row) => row.includes("Discipline not classified") && !row.includes("Open now"));
  assert.ok(quiet.length > 0, "not every fixture is open");
  for (const row of quiet) assert.match(row, /confidence/i, row.slice(0, 90));
});

test("a window still ahead is a likelihood, and one that has begun is an expectation", () => {
  // Case 2: the window has not begun.
  assert.equal(windowState(WINDOW, "2027-06-19"), "ahead");
  assert.equal(outlookLabel("ahead"), "Likely around");
  assert.equal(outlookNote("ahead"), null);

  // Case 3: the window has begun and the expected date is still to come.
  assert.equal(windowState(WINDOW, "2027-06-20"), "expected_ahead");
  assert.equal(windowState(WINDOW, "2027-07-16"), "expected_ahead");
  assert.equal(outlookLabel("expected_ahead"), "Expected around");
  assert.equal(outlookNote("expected_ahead"), null);
});

test("an expected date that has gone by says so, on the day it passes", () => {
  // Case 4. The boundary is the expected day itself: on it, the date is no longer ahead.
  assert.equal(windowState(WINDOW, "2027-07-17"), "expected_passed");
  assert.equal(windowState(WINDOW, "2027-08-14"), "expected_passed");
  assert.equal(outlookLabel("expected_passed"), "Expected around");
  assert.equal(outlookNote("expected_passed"), "Not seen open yet");

  // A window stored before the model kept its end ahead of today is in the same state, and the words still hold.
  assert.equal(windowState(WINDOW, "2028-01-01"), "expected_passed");
});

test("nothing here does date arithmetic: every state is a comparison of stored days", () => {
  const source = readFileSync(new URL("../lib/forecast-window.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function windowState"));
  assert.doesNotMatch(body, /Date|getTime|setDate|\+ 1|- 1|86400/, "a case is decided by comparing dates, never by moving one");
});

test("every surface that draws a forecast names the day it is drawn on", () => {
  // A surface that cannot say which day it is cannot tell case 2 from case 4, so the prop is required rather than
  // optional: a missing one is a type error, and this fails if a new surface is added without it.
  const web = fileURLToPath(new URL("..", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx")) files.push([path, readFileSync(path, "utf8")]);
    }
  };
  walk(join(web, "components"));
  const drawn = files.filter(([, source]) => /<LikelyWindow|<ForecastRow/.test(source));
  assert.ok(drawn.length >= 5, `found ${drawn.length} surfaces`);
  for (const [path, source] of drawn) {
    for (const [tag] of source.matchAll(/<(?:LikelyWindow|ForecastRow)\b[^>]*>/g)) {
      assert.match(tag, /\btoday=\{/, `${path.slice(web.length)} draws a forecast without naming the day`);
    }
  }
});
