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
  find("identifier", /\b[a-z]+(?:_[a-z0-9]+)+\b/);
  for (const word of DEV_WORDS) find("dev word", word);
  return leaks;
}
