import assert from "node:assert/strict";
import test from "node:test";
import { publishedSitePages } from "../lib/site-links.ts";

// The dashboard renders fixtures only under an explicit opt-in, so these
// development-data assertions must request demo mode deliberately.
process.env.FIRSTSEEN_DEMO_MODE = "true";

async function render(pathname = "/", { demo = true } = {}) {
  const previous = process.env.FIRSTSEEN_DEMO_MODE;
  if (demo) process.env.FIRSTSEEN_DEMO_MODE = "true";
  else delete process.env.FIRSTSEEN_DEMO_MODE;
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    return await worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  } finally {
    if (previous === undefined) delete process.env.FIRSTSEEN_DEMO_MODE;
    else process.env.FIRSTSEEN_DEMO_MODE = previous;
  }
}

test("server-renders the 1stSeen forecast product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Forecasts · 1stSeen<\/title>/i);
  assert.match(html, /Recruiting intelligence/);
  assert.match(html, /Roles and forecasts/);
  assert.match(html, /Development fixture/);
  assert.match(html, /Why this confidence/i);
  assert.doesNotMatch(html, /react-loading-skeleton/i);
});

test("renders canonical role intelligence with explicit uncertainty semantics", async () => {
  const response = await render("/roles/northstar-swe-intern");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Northstar Software Engineering Intern · 1stSeen/);
  assert.match(html, /Exactly what contributed to this forecast/);
  // The provenance section states its total over every linked contribution, not over the page on
  // screen, so a truncated list can never read as the whole of it.
  assert.match(html, /What the model weighed, over all\s*(?:<[^>]+>\s*)*4\s*(?:<[^>]+>\s*)*contributions/);
  assert.match(html, /Every contribution, with the record it was read from/);
  // The three precision classes must stay visually and verbally distinct.
  assert.match(html, /Exact/);
  assert.match(html, /Bounded/);
  assert.match(html, /Observed by/);
  assert.match(html, /The source supplied this publication date/);
  assert.match(html, /A complete earlier capture proved absence/);
  assert.match(html, /The role was visible by this date\. It may have opened earlier/);
  assert.match(html, /Investigate with 1stSeen Agent/);
  assert.match(html, /Watch the agent operate over tools and evidence/);
  assert.match(html, /Identified recruiting system/);
  assert.match(html, /Resolved role aliases/);
  assert.match(html, /Retrieved historical cycles/);
  assert.match(html, /Inspected archived evidence/);
  assert.match(html, /Generated statistical forecast/);
  assert.match(html, /Calculated readiness timeline/);
  assert.match(html, /Each step is a tool the agent ran and what it returned/);
});

test("role intelligence distinguishes signals, reliability, and model ownership", async () => {
  const html = await (await render("/roles/northstar-swe-intern")).text();
  assert.match(html, /Community evidence is supporting-only/);
  assert.match(html, /source reliability/i);
  assert.match(html, /hierarchical-circular-shrinkage-v2/);
  // The forecast's own uncertainty stays on it: the interval, the cycles behind it, the confidence and what it means.
  assert.match(html, /80% prediction interval, computed by/);
  assert.match(html, /Recruiting cycles used/);
  assert.match(html, /not the chance that it is right/);
  assert.match(html, /Signals carry zero date weight/i);
  // Confidence is a 0 to 100 evidence score, never a probability, so it is never written with a percent sign.
  assert.match(html, /Confidence score<\/dt><dd[^>]*>[\d.]+ \/ 100</);
  assert.doesNotMatch(html, /confidence[^<]{0,40}\d%|\d(?:\.\d)?%\s*(?:<[^>]+>\s*)*confidence/i);
  // Model fields read as plain labels; the exact field names stay under Model details.
  assert.doesNotMatch(html, /Canonical recurring role|Model-ready cycles|role_history contribution/i);
});

test("a role without enough cycles states the gap instead of showing a window", async () => {
  const html = await (await render("/roles/meridian-apm")).text();
  // A statement about the history, not a warning.
  assert.match(html, /Too little history to forecast this role/);
  assert.match(html, /Not forecastable yet/);
  // The rule forecasting.py applies, not the "two cycles" the product used to claim (lib/forecast-gap).
  assert.match(html, /fewer than three distinct recruiting cycles is forecast only when a comparable program/i);
  assert.doesNotMatch(html, /two (?:distinct )?recruiting cycles|a forecast needs two/i);
  // No interval, confidence, or expected date may appear for an unforecastable role.
  assert.doesNotMatch(html, /Prediction interval/);
  assert.doesNotMatch(html, /Calibrated probability<\/dt><dd[^>]*>0\./);
});

test("fixture role pages are unreachable when demo mode is not explicitly enabled", async () => {
  const response = await render("/roles/northstar-swe-intern", { demo: false });
  assert.equal(response.status, 404);
});

test("Forecast Replay never presents a precomputed result or a hardcoded audit verdict", async () => {
  const response = await render("/replay");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Forecast Replay · 1stSeen/);
  assert.match(html, /Future evidence is sealed/);
  assert.match(html, /computed by the worker/i);
  // Replay reads real reconstructed openings; with no database it says so.
  assert.match(html, /Live data is not configured/);
  // A leakage verdict may only be derived from a returned result.
  assert.doesNotMatch(html, /Leakage audit passed/i);
  assert.doesNotMatch(html, /Absolute date error/);
  assert.doesNotMatch(html, /average accuracy|success rate/i);
});

test("renders a recruiting calendar that separates predicted and confirmed dates", async () => {
  const response = await render("/calendar");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Recruiting Calendar · 1stSeen/);
  assert.match(html, /What you need to do this week/);
  assert.match(html, /Start networking/);
  assert.match(html, /Resume-ready deadline/);
  assert.match(html, /Predicted window starts/);
  assert.match(html, /Applications opened/);
  // The three kinds of date stay apart through their own legend and styling, not a sentence about it.
  assert.match(html, /aria-label="Legend"/);
  assert.match(html, /Predicted opening/);
  assert.match(html, /Confirmed opening/);
});

test("the calendar shows no events when demo mode is not explicitly enabled", async () => {
  const html = await (await render("/calendar", { demo: false })).text();
  assert.match(html, /Live data is not configured/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas/);
});

test("the digest preview is empty rather than fixture-backed outside demo mode", async () => {
  const html = await (await render("/digests", { demo: false })).text();
  assert.match(html, /Live data is not configured/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas/);
  assert.doesNotMatch(html, /Development fixture/);
});

test("renders an explicit preview-only email intelligence digest", async () => {
  const response = await render("/digests");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Email intelligence digests · 1stSeen/);
  assert.match(html, /Email preview/);
  assert.match(html, /Predicted to open soon/);
  assert.match(html, /Material forecast changes/);
  assert.match(html, /Networking approaching/);
  assert.match(html, /Gmail is always opt-in/);
  assert.match(html, /Connecting Gmail does not schedule or send anything/);
  assert.match(html, /Forecast dates are labeled as statistical predictions/);
});

test("renders evidence and preparation language", async () => {
  const html = await (await render()).text();
  assert.match(html, /Forecast evidence/);
  assert.match(html, /Work-back plan/);
  assert.match(html, /Roles that opened/);
  assert.match(html, /Forecast changes/);
  assert.match(html, /Agent activity/);
  assert.match(html, /Archive dates show when content existed/);
});

test("labels fixture provenance and derives visible portfolio counts", async () => {
  const html = await (await render()).text();
  assert.match(html, />2<\/strong><span[^>]*>of <!-- -->3 forecasts<!-- --> in this view/);
  // The default view states the whole in-scope set, not only the forecasts.
  assert.match(html, /in-scope roles: /);
  assert.match(html, /reserved \.example sources/);
  assert.match(html, /Every displayed count is derived/);
});

test("the dashboard shows an unconfigured workspace, not fixtures, without an opt-in", async () => {
  const html = await (await render("/", { demo: false })).text();
  assert.match(html, /Not configured/);
  assert.match(html, /Live data is not configured/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas/);
  assert.doesNotMatch(html, />Development fixture</);
});

/** The document without its inline RSC payload, which repeats every server-rendered string. */
function visible(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
}

test("every page says the product-wide disclosure once, in its footer, linked to methodology and the policy pages", async () => {
  for (const path of ["/", "/roles/northstar-swe-intern", "/roles/meridian-apm", "/calendar", "/replay", "/digests", "/signin", "/methodology"]) {
    const html = visible(await (await render(path)).text());
    // The page body streams after the layout, so the site footer is found by its text, not by position.
    const at = html.indexOf("Opening dates on 1stSeen");
    assert.ok(at > 0, `${path} renders the disclosure`);
    const footer = html.slice(html.lastIndexOf("<footer", at), html.indexOf("</footer>", at));
    assert.match(footer, /Opening dates on 1stSeen are predictions from each program(?:&#x27;|')s public posting history, and their accuracy is not\s+yet validated\./, path);
    assert.match(footer, /not affiliated with or endorsed by any company it lists/, path);
    for (const page of publishedSitePages(Boolean(process.env.FIRSTSEEN_CONTACT_EMAIL))) assert.match(footer, new RegExp(`href="${page.href}"`), `${path} links ${page.href}`);
    assert.equal(html.match(/not affiliated with or endorsed/g)?.length, 1, `${path} says it once`);
    assert.equal(html.match(/accuracy is not\s+yet validated/g)?.length, 1, `${path} says it once`);
  }
});

test("the methodology page explains the evidence model and states the backtest position it can read", async () => {
  const response = await render("/methodology");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Methodology and accuracy · 1stSeen<\/title>/);
  assert.match(html, /How forecasts are made, and how accurate they are/);
  // Without a database there is no backtest to report, and no fixture stands in for one.
  assert.match(html, /not connected to its database, so there is no backtest to report/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas/);
  // The evidence classes, with what each means.
  assert.match(html, /The job board published the date itself/);
  assert.match(html, /A complete archive capture shows the program absent and a later one shows it present/);
  assert.match(html, /An archive capture timestamp is never treated as an exact opening date/);
  // The forecast, the confidence score, and the agent, in the terms the rest of the product relies on.
  assert.match(html, /fewer than three recruiting cycles of its own is forecast only when comparable programs/);
  assert.match(html, /It is not the chance that the window is right, and it has not been calibrated/);
  assert.match(html, /No language model produces a date, an interval, or a score/);
  assert.match(html, /never its prompts or private reasoning/);
  assert.doesNotMatch(html, /\d+(?:\.\d+)?\s*\/\s*100\s*%|confidence[^<]{0,40}\d%/i);
});

// What is true of every forecast is said once, in the footer. These are the sentences each surface used to repeat.
const REMOVED_HEDGES = [
  /not a\s+guaranteed application period/i,
  /not a company announcement/i,
  /not confirmed company dates|not a confirmed company date/i,
  /Nothing is filled in to look complete/,
  /cannot invent dates or confidence/,
  /calculated honestly/,
  /manufactur(?:ed|e an) /,
  /not an accuracy claim/,
  /working, not an error/,
  /No seeded performance aggregate/,
  /never share a visual language/,
  /never imply a confirmed/,
  /Private reasoning, prompts, and credentials never enter/,
  /An archive capture timestamp is never treated as an exact opening date/,
  /their accuracy has not yet been validated against/,
];

test("no surface repeats the product-wide disclosure; only the methodology page explains it", async () => {
  for (const path of ["/", "/roles/northstar-swe-intern", "/roles/meridian-apm", "/calendar", "/replay", "/digests"]) {
    const html = visible(await (await render(path)).text());
    for (const hedge of REMOVED_HEDGES) assert.doesNotMatch(html, hedge, `${path}: ${hedge}`);
  }
  const unconfigured = visible(await (await render("/", { demo: false })).text());
  for (const hedge of REMOVED_HEDGES) assert.doesNotMatch(unconfigured, hedge, `unconfigured: ${hedge}`);
});

// Every forecast says what its window rests on, the program's own openings or comparable programs' timing, as
// data beside the evidence classes (lib/forecast-basis). Fixtures carry labelled fixture weights so both bases render.
test("a forecast shows its basis wherever it appears", async () => {
  const dashboard = visible(await (await render("/")).text());
  assert.match(dashboard, /Own history 74%/, "the dashboard card of a forecast resting on its own openings");
  assert.match(dashboard, /Borrowed timing 58%/, "and of one borrowing comparable programs' timing");
  assert.match(dashboard, /of the weight from comparable programs/, "the chip says what its share is of, to a screen reader");

  const role = visible(await (await render("/roles/northstar-swe-intern")).text());
  assert.match(role, /What the window rests on/);
  assert.match(role, /(?:Own history|Borrowed timing) \d+%/);

  const calendar = visible(await (await render("/calendar")).text());
  assert.match(calendar, /Own history 74%|Borrowed timing 58%/, "a predicted calendar boundary carries its forecast's basis");

  const digest = await (await render("/digests")).text();
  assert.match(digest, /based mainly on this program(?:&#x27;|')s own openings \(74% of the weight\)/, "the digest's opening-soon item states it");

  const insufficient = visible(await (await render("/roles/meridian-apm")).text());
  assert.doesNotMatch(insufficient, /Own history \d+%|Borrowed timing \d+%/, "a role with no forecast has no basis");
});
