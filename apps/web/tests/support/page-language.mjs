/**
 * What a user page must never show: identifiers, fingerprints, timings, tool names, and words from inside the machine.
 *
 * Reads a rendered page's visible text (no scripts, no tags, no attributes) and reports every leak. Used by the gate on
 * the development pages and by the integration suite on real ones.
 */

const TOOL_NAMES = [
  "discover_company", "get_current_jobs", "inspect_career_page", "get_role_history", "inspect_archives",
  "get_recruiting_signals", "resolve_role", "generate_forecast", "get_forecast_evidence", "create_readiness_plan",
  "answer_portfolio_question", "recruiting_agent",
];

const DEV_WORDS = [
  /\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\[object Object\]/, /\bTODO\b/, /\bFIXME\b/, /\blorem ipsum\b/i,
  /\blocalhost\b/, /127\.0\.0\.1/, /\bSUPABASE\w*/, /\bservice[_ ]role\b/i, /\bPostgREST\b/, /\bRPC\b/, /\brpc\b/,
  /\bstack trace\b/i, /\bTraceback\b/, /\bdebug\b/i, /\bstub\b/i, /\bLLM\b/, /\bmodel provider\b/i, /\bAPI key\b/i,
  /\bbearer\b/i, /process\.env/, /\bvinext\b/i, /\bCloud Run\b/, /\bfixture\b/i, /\bhistory_count\b/, /\binput fingerprint\b/i,
  /\bcontent hash\b/i, /\btool[- ]call\b/i,
];

/**
 * Phrases a confident product does not need. A page that shows the thing does not also promise that the thing is real,
 * and a product written by a person does not reach for the words every landing page reaches for.
 *
 * These are checked on the product's own surfaces. The methodology and policy pages are exempt by their nature: saying
 * that no language model picks a date, or how honest the accuracy position is, is their whole job.
 */
const SELF_CONSCIOUS = [
  /\breal (?:program|programs|forecast|forecasts|data)\b/i,
  /\bhonest(?:ly)?\b/i,
  /\bevidence[- ]first\b/i,
  /\bno language model\b/i,
  /\bnever fake[sd]?\b/i,
  /\bactually\b/i,
];

const MARKETING = [/\bseamless(?:ly)?\b/i, /\bunlock\b/i, /\bsupercharge\b/i, /\bempower(?:s|ing)?\b/i, /\bjourney\b/i, /\brevolutionar/i, /\bgame[- ]chang/i];

/**
 * Words from inside the build, in copy a person reads. Someone signing in has not arrived at a "workspace", does not
 * have a "deployment", and has never thought about a session cookie; and what the site follows is a program, which it
 * should be called on every page and not only on most of them. ("Readiness milestones" is the same kind of phrase and
 * still reaches the calendar, digest, and Google Calendar pages; those are their own copy pass.)
 */
const INSIDE_OUT = [
  /\brecruiting workspace\b/i,
  /\bthis deployment\b/i,
  /\bsession cookie\b/i,
  /\bsince last run\b/i,
  /\bforecast changes\b/i,
  /\bexplicit opt-in\b/i,
  /\bthreshold crossed\b/i,
];

/**
 * The site follows programs. "Role" is the word the database uses for the same thing, and it reached the pages a
 * person reads in a dozen places while the rest of the product said program. These are the phrases that leaked; the
 * word on its own is not banned, because a company's own job title may carry it and the methodology page explains
 * what an early-career technical role is.
 */
const WRONG_NOUN = [
  /\bwatched roles?\b/i,
  /\broles you watch\b/i,
  /\brole page\b/i,
  /\bBrowse (?:every )?roles?\b/i,
  /\brole families\b/i,
  /\b\d+ of \d+ roles match\b/i,
  /\byou watch \d+ roles?\b/i,
  /\bthe roles you follow\b/i,
];

/**
 * Every voice leak in the product's own words. This reads source files, not rendered pages: a company's job title can
 * carry an em dash or the word "honest", and that is their copy, not ours. Comments are stripped first, so only what
 * reaches a person is checked.
 */
export function voiceLeaksInSource(source) {
  const copy = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const leaks = [];
  const find = (kind, pattern) => {
    for (const match of copy.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) leaks.push(`${kind}: ${match[0].trim()}`);
  };
  for (const pattern of SELF_CONSCIOUS) find("self-conscious", pattern);
  for (const pattern of MARKETING) find("marketing", pattern);
  for (const pattern of INSIDE_OUT) find("inside out", pattern);
  for (const pattern of WRONG_NOUN) find("wrong noun", pattern);
  // An em dash is a writer's tic here: the product's sentences are short enough not to need one.
  find("em dash", /\u2014/);
  return leaks;
}

/** The text a person reads: scripts, styles, and tags removed, entities decoded. */
export function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Every leak in a page's visible text, as "kind: match". `allow` removes phrases a page is required to show first (a
 * development page's own "Development fixture" label and its reserved .example addresses).
 */
export function pageLanguageLeaks(html, { allow = [] } = {}) {
  let text = visibleText(html);
  for (const phrase of allow) text = text.split(phrase).join(" ");
  const leaks = [];
  const find = (kind, pattern) => {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) leaks.push(`${kind}: ${match[0]}`);
  };
  find("uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  find("hash", /\b[0-9a-f]{16,}\b/i);
  find("timing", /\b\d+(?:\.\d+)?\s?ms\b/);
  for (const tool of TOOL_NAMES) find("tool", new RegExp(`\\b${tool}\\b`));
  // Any snake_case string at all: an enum, a column, or a reason code that reached the page instead of a sentence.
  find("snake case", /\b[a-z]+(?:_[a-z0-9]+)+\b/);
  for (const word of DEV_WORDS) find("dev word", word);
  for (const pattern of INSIDE_OUT) find("inside out", pattern);
  for (const pattern of WRONG_NOUN) find("wrong noun", pattern);
  return leaks;
}
