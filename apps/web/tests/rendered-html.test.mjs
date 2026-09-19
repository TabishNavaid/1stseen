import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { publishedSitePages } from "../lib/site-links.ts";
import { pageLanguageLeaks, voiceLeaksInSource } from "./support/page-language.mjs";

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

test("server-renders the 1stSeen forecast product at /roles", async () => {
  const response = await render("/roles");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Forecasts · 1stSeen<\/title>/i);
  assert.match(html, /Explore roles/);
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
  assert.match(html, /Sources and weights/);
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
  // The agent check lists its steps in plain words, never by tool name.
  assert.match(html, /Check the latest evidence/);
  assert.match(html, /Check now/);
  assert.match(html, /Found the company(?:&#x27;|')s job board/);
  assert.match(html, /Matched the program(?:&#x27;|')s past titles/);
  assert.match(html, /Looked up past openings/);
  assert.match(html, /Checked archived copies/);
  assert.match(html, /Worked out the likely date/);
  assert.match(html, /Built a prep plan/);
  // Evidence classes appear only in History, as an icon whose tooltip names the class and says what it means.
  assert.match(html, /role="tooltip"[^>]*>(?:<[^>]+>)*Exact(?:<!-- -->)?\./);
});

test("role intelligence distinguishes signals, reliability, and model ownership", async () => {
  const html = await (await render("/roles/northstar-swe-intern")).text();
  assert.match(html, /Community evidence is supporting-only/);
  assert.match(html, /source reliability/i);
  assert.match(html, /hierarchical-circular-shrinkage-v2/);
  // The forecast's own uncertainty stays on it: the interval, the cycles behind it, the confidence and what it means.
  assert.match(html, /The window holds 80% of the likely dates/);
  assert.match(html, /Recruiting cycles used/);
  assert.match(html, /not the chance that it is right/);
  assert.match(html, /News about hiring never moves the date/i);
  // Confidence is a 0 to 100 evidence score, never a probability, so it is never written with a percent sign.
  assert.match(html, /Confidence score<\/dt><dd[^>]*>[\d.]+ \/ 100</);
  assert.doesNotMatch(html, /confidence[^<]{0,40}\d%|\d(?:\.\d)?%\s*(?:<[^>]+>\s*)*confidence/i);
  // Model fields read as plain labels; the exact field names stay under Model details.
  assert.doesNotMatch(html, /Canonical recurring role|Model-ready cycles|role_history contribution/i);
});

test("a shared link previews as the production landing page, at the size link previews expect", async () => {
  const html = await (await render("/")).text();
  assert.match(html, /<meta property="og:image" content="[^"]*\/og-image\.png"/);
  assert.match(html, /<meta property="og:image:width" content="1200"/);
  assert.match(html, /<meta property="og:image:height" content="630"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(html, /<meta name="twitter:image" content="[^"]*\/og-image\.png"/);
  // The file itself is a PNG of exactly that size: its header's width and height fields.
  const png = readFileSync(new URL("../public/og-image.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test("a role page reads top to bottom: the date and Save, History, Prep plan, Ask, then one collapsed expander", async () => {
  const html = await (await render("/roles/northstar-swe-intern")).text();
  const text = visible(html);
  // No tab bar.
  assert.doesNotMatch(html, /aria-label="Role intelligence sections"/);
  // The hero holds the likely date, the confidence word, and Save.
  const hero = html.slice(html.indexOf('aria-labelledby="role-title"'), html.indexOf('id="history"'));
  assert.match(hero, /Likely around/);
  assert.match(hero, /confidence/);
  assert.match(hero, /Save to my watchlist/);
  // The sections, in order, then everything the model used behind one closed expander.
  const order = ["When it opened before", "Get ready before it opens", "Check the latest evidence", "How this forecast was made"].map((label) => text.indexOf(label));
  assert.ok(order.every((index) => index > 0), order.join(","));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((text.match(/How this forecast was made/g) ?? []).length, 1);
  const expander = /<details[^>]*id="how-made"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(expander, "the expander is a details element");
  assert.doesNotMatch(expander, /\sopen(?:=|\s|>)/, "collapsed by default");
  const inside = html.slice(html.indexOf('id="how-made"'));
  for (const detail of ["Sources and weights", "Model details", "Earlier versions of this forecast", "Forecasted ", "days until it starts", "Exact dates"]) {
    assert.ok(inside.includes(detail), `${detail} is inside the expander`);
    assert.ok(!html.slice(0, html.indexOf('id="how-made"')).includes(detail), `${detail} is not outside it`);
  }
});

test("a role page draws no empty section and no unstated place", async () => {
  const html = await (await render("/roles/meridian-apm")).text();
  const text = visible(html);
  assert.doesNotMatch(text, /No recruiting news/);
  assert.doesNotMatch(text, /No past opening of this program has been recorded/);
  const eyebrow = html.slice(html.indexOf('aria-labelledby="role-title"'), html.indexOf('id="role-title"'));
  assert.doesNotMatch(eyebrow, /Location not stated/);
  assert.match(text, /Why there is no date yet/);
});

test("a role without enough cycles states the gap instead of showing a window", async () => {
  const html = await (await render("/roles/meridian-apm")).text();
  // A statement about the history, not a warning.
  assert.match(html, /Too little history to forecast this role/);
  assert.match(html, /No date yet/);
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
  const html = await (await render("/roles")).text();
  assert.match(html, /Forecast evidence/);
  assert.match(html, /Work-back plan/);
  assert.match(html, /Forecast changes/);
  assert.match(html, /Archive dates show when content existed/);
  // The count of openings links to Just opened; the list itself lives there.
  assert.match(html, /href="\/opened"[^>]*>[\s\S]*?Just opened/);
  assert.match(html, /programs opened in the last 45 days/);
});

test("Just opened lists programs by the date they were posted, labelled as fixtures here", async () => {
  const response = await render("/opened");
  assert.equal(response.status, 200);
  const html = visible(await response.text());
  assert.match(html, /<title>Just opened · 1stSeen<\/title>|Just opened/);
  assert.match(html, /programs opened in the last 45 days\. Newest first, mixed so one company cannot fill the list/);
  assert.match(html, /Development fixture/);
  assert.match(html, /Opened/);
  const unconfigured = visible(await (await render("/opened", { demo: false })).text());
  assert.doesNotMatch(unconfigured, /Pioneer|Lumen/, "no fixture without the opt-in");
});

test("Ask is open to guests, with its limit stated in words", async () => {
  const response = await render("/ask");
  assert.equal(response.status, 200);
  const html = visible(await response.text());
  assert.match(html, /Ask about any program/);
  assert.match(html, /Without an account you can ask 5 questions a minute\./);
  assert.match(html, /Which companies open their internships earliest\?/);
});

test("labels fixture provenance and derives visible portfolio counts", async () => {
  const html = await (await render("/roles")).text();
  assert.match(html, />2<\/span><\/strong><span[^>]*>of <!-- -->3 forecasts<!-- --> in this view/);
  // The default view states the whole in-scope set, not only the forecasts.
  assert.match(html, /in-scope roles: /);
  assert.match(html, /reserved \.example sources/);
  assert.match(html, /Every displayed count is derived/);
});

test("the dashboard shows an unconfigured workspace, not fixtures, without an opt-in", async () => {
  const html = await (await render("/roles", { demo: false })).text();
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
  for (const path of ["/", "/roles", "/roles/northstar-swe-intern", "/roles/meridian-apm", "/calendar", "/replay", "/digests", "/signin", "/welcome", "/methodology"]) {
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
  for (const path of ["/", "/roles", "/roles/northstar-swe-intern", "/roles/meridian-apm", "/calendar", "/replay", "/digests"]) {
    const html = visible(await (await render(path)).text());
    for (const hedge of REMOVED_HEDGES) assert.doesNotMatch(html, hedge, `${path}: ${hedge}`);
  }
  const unconfigured = visible(await (await render("/roles", { demo: false })).text());
  for (const hedge of REMOVED_HEDGES) assert.doesNotMatch(unconfigured, hedge, `unconfigured: ${hedge}`);
});

// A card shows "Likely around" a date, its window, and one confidence word. What the window rests on, the program's own
// openings or comparable programs' timing, is one step away: the evidence drawer and the role page's "How this forecast
// was made" (lib/forecast-basis). Fixtures carry labelled fixture weights so the basis renders.
test("a forecast's basis is one step away, never on its card", async () => {
  const dashboard = visible(await (await render("/roles")).text());
  const drawerStart = dashboard.indexOf("forecast detail");
  const cards = dashboard.slice(0, dashboard.lastIndexOf("<aside", drawerStart));
  assert.doesNotMatch(cards, /Own history \d+%|Borrowed timing \d+%/, "no basis chip on a card");
  assert.match(cards, /Low confidence|Medium confidence|High confidence/, "the card shows one confidence word");
  assert.doesNotMatch(cards, /\d+ days to interval|cycles? behind it/, "no model arithmetic on a card");
  assert.match(dashboard.slice(drawerStart), /Own history \d+%|Borrowed timing \d+%/, "the drawer states the basis");

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

// The front door is a landing page, never the app: one idea per section, plain words, nothing that reads as broken.
test("a first-time visitor lands on the landing page, not the app shell", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = visible(await response.text());
  assert.match(html, /Know when internships open,/);
  assert.match(html, /href="\/welcome"[^>]*>Get started/);
  assert.match(html, /href="\/roles"[^>]*>\s*Browse programs/);
  assert.match(html, /How it works/);
  assert.match(html, /Start watching the programs you care about/);
  assert.match(html, /href="\/methodology"/);
  // The questions a first-time visitor asks, answered on the page itself.
  for (const question of ["Is it free?", "Where do the dates come from?", "How accurate is it?", "Do I need an account?", "Which companies are covered?"]) {
    assert.ok(html.includes(question), question);
  }
  assert.equal((html.match(/<details/g) ?? []).length, 5, "five questions, each its own disclosure");
  // No dashboard: no workspace navigation, no watchlist count, no stat tile, no debug-looking status pill.
  assert.doesNotMatch(html, /Recruiting workspace|Watchlist|Watched roles|Recruiting calendar/);
  assert.doesNotMatch(html, /data-stat-tile/);
  assert.doesNotMatch(html, />Real data</);
  // The evidence model's vocabulary lives on the methodology page, not on the front door.
  assert.doesNotMatch(html, /corpus|hindsight|Observed by|Bounded|Exact\b/);
  // With no data behind it the preview card and "Opening soon" are left out rather than drawn empty or from fixtures.
  assert.doesNotMatch(html, /A real program we track|Opening soon|Next to open/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas|\.example/);
  // With no data there is no status line and no hero chart, rather than an empty one.
  assert.doesNotMatch(html, /openings this month|<svg[^>]*role="group"/);
});

test("an old link to a filtered dashboard on / goes to the same view at /roles", async () => {
  const response = await render("/?discipline=data&page=2");
  assert.ok([307, 308].includes(response.status), `redirects, got ${response.status}`);
  assert.equal(new URL(response.headers.get("location"), "http://localhost").pathname, "/roles");
  assert.match(response.headers.get("location"), /discipline=data/);
  assert.match(response.headers.get("location"), /page=2/);
});

test("a guest's roles view renders no zero tile and no watched tile", async () => {
  for (const [path, demo] of [["/roles", true], ["/roles", false]]) {
    const html = visible(await (await render(path, { demo })).text());
    assert.doesNotMatch(html, /Watched roles/, "a guest follows nothing, so the watched tile is never drawn");
    for (const [tile] of html.matchAll(/data-stat-tile[\s\S]*?<\/strong>/g)) {
      const value = Number(tile.match(/>([\d,]+)<\/span><\/strong>$/)?.[1]?.replace(/,/g, ""));
      assert.ok(value > 0, `a tile shows ${value}`);
    }
  }
  const unconfigured = visible(await (await render("/roles", { demo: false })).text());
  assert.doesNotMatch(unconfigured, /data-stat-tile/, "an empty deployment draws no tiles at all");
});

test("a guest's navigation is Explore, Just opened, and Ask, and nothing else", async () => {
  for (const path of ["/", "/roles", "/opened", "/ask"]) {
    const html = visible(await (await render(path)).text());
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    for (const label of ["Explore", "Just opened", "Ask"]) assert.match(header, new RegExp(`>${label}<`), `${path}: ${label}`);
    for (const label of ["Watchlist", "Calendar", "Replay", "Digests"]) assert.doesNotMatch(header, new RegExp(`>${label}<`), `${path}: no ${label}`);
  }
  assert.match(visible(await (await render("/roles")).text()), /aria-current="page"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Explore/);
  // Replay is still reached from the methodology page.
  assert.match(visible(await (await render("/methodology")).text()), /href="\/replay"/);
});

test("user pages show no identifiers, fingerprints, timings, tool names, or words from inside the machine", async () => {
  // A development page must say it is one and may show its reserved .example sources, and a deployment without live
  // data names the two settings its operator must set (Replay has no fixtures, so it shows that here); nothing else.
  const allow = ["Development fixture", "development fixture", "Development fixtures are never shown in production", "reserved .example sources", "the fixture records on this page", ".example", "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"];
  for (const path of ["/", "/roles", "/roles/northstar-swe-intern", "/roles/meridian-apm", "/opened", "/ask", "/methodology", "/replay", "/signin"]) {
    const leaks = pageLanguageLeaks(await (await render(path)).text(), { allow });
    assert.deepEqual(leaks, [], path);
  }
});

test("the product's own words do not reassure, sell, or reach for an em dash", async () => {
  // The methodology and policy pages are exempt by their nature: saying that no language model picks a date is their job.
  const exempt = /^(app\/(methodology|privacy|terms|data-sources|contact)|app\/layout)/;
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const next = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, next);
      else if (/\.tsx?$/.test(entry.name)) files.push([next.slice(1), `${dir}/${entry.name}`]);
    }
  };
  walk("../app", "/app");
  walk("../components", "/components");
  assert.ok(files.length > 40, `${files.length} source files`);
  const leaks = [];
  for (const [name, path] of files) {
    if (exempt.test(name)) continue;
    for (const leak of voiceLeaksInSource(readFileSync(new URL(path, import.meta.url), "utf8"))) leaks.push(`${name} ${leak}`);
  }
  assert.deepEqual(leaks, []);
});

test("a landing page moves, but only with motion that can be switched off", async () => {
  const html = await (await render("/")).text();
  // Every animated thing on the page carries one of these, and every one of them is off under reduced motion.
  for (const utility of ["rise", "press"]) assert.ok(html.includes(utility), utility);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const utility of ["rise", "fade-in", "drop-in", "drift-track", "press"]) {
    assert.match(css, new RegExp(`@utility ${utility} \\{`), utility);
  }
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const selector of [".rise", ".fade-in", ".drop-in", ".drift-track", ".press:active"]) {
    assert.ok(reduced.includes(selector), `${selector} is switched off under reduced motion`);
  }
  assert.match(css, /@view-transition \{ navigation: auto; \}/);
  assert.match(reduced, /::view-transition-group\(\*\)[^}]*animation: none/);
});

test("the first run renders for a guest, and says so plainly when live data is not configured", async () => {
  const response = await render("/welcome", { demo: false });
  assert.equal(response.status, 200, "a guest is not sent to sign in");
  const html = visible(await response.text());
  assert.match(html, /Get started/);
  assert.match(html, /Live data is not configured/);
  assert.doesNotMatch(html, /Northstar|Meridian|Atlas/);
});

test("the methodology page carries the evidence model the front page no longer explains", async () => {
  const html = visible(await (await render("/methodology")).text());
  assert.match(html, /Why the evidence model matters/);
  assert.match(html, /Dates keep their precision/);
  assert.match(html, /Numbers come from statistics/);
  assert.match(html, /Replays refuse hindsight/);
});
