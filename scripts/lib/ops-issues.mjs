/**
 * One open GitHub issue per operational problem: the single place a failure reaches the owner.
 *
 * An issue labelled `ops-alert` is opened for a problem, assigned to the owner (GitHub sends email, and a push to GitHub
 * Mobile for an assignment), updated in place while the problem persists, and closed with a comment when it clears.
 * docs/operations.md describes the design and the one-time setup.
 *
 * Deduplication: each problem has a stable key, stored as a hidden marker in the issue body. A problem that is already
 * open is edited silently (an edit sends no notification) unless what is wrong has changed, or the last notification is
 * more than a day old, in which case a comment is added, which does notify. So a collector failing four times a day
 * produces one issue and at most one reminder a day, not one message per run.
 *
 * Nothing secret reaches an issue: every title, body, and comment passes through `redact`, which removes the value of
 * every credential-like environment variable present and anything shaped like a JWT, API key, bearer token, or
 * connection string. Callers also only ever pass their own findings, never a response body.
 *
 * Needs GITHUB_TOKEN (with `issues: write`) and GITHUB_REPOSITORY, which GitHub Actions provides. Without them it reports
 * that alerting is not configured and does nothing.
 */

import { createHash } from "node:crypto";

export const ALERT_LABEL = "ops-alert";
const REMIND_AFTER_MS = 24 * 3_600_000;
const MAX_BODY = 60_000;

const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|DB_URL)$|^SUPABASE_URL$/;
const SENSITIVE_SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, // Supabase API keys
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bpostgres(?:ql)?:\/\/\S+/gi,
];

/** Removes credential values and credential-shaped strings from text bound for an issue. */
export function redact(text, env = process.env) {
  let out = String(text ?? "");
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_NAME.test(name) || !value || value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  for (const shape of SENSITIVE_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

const marker = (name, value) => `<!-- ops-alert-${name}: ${value} -->`;
const readMarker = (body, name) => new RegExp(`<!-- ops-alert-${name}: (.*?) -->`).exec(body ?? "")?.[1] ?? null;

export function runUrl(env = process.env) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  return `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function client(env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  return async function github(method, path, body) {
    const response = await fetch(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      // The status is enough to act on; response bodies are not echoed.
      const error = new Error(`GitHub ${method} ${path.split("?")[0]} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

async function findOpen(github, key) {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await github("GET", `/issues?state=open&labels=${ALERT_LABEL}&per_page=100&page=${page}`);
    if (!issues?.length) return null;
    const match = issues.find((issue) => !issue.pull_request && readMarker(issue.body, "key") === key);
    if (match) return match;
    if (issues.length < 100) return null;
  }
  return null;
}

async function ensureLabel(github) {
  if (await github("GET", `/labels/${ALERT_LABEL}`)) return;
  await github("POST", "/labels", {
    name: ALERT_LABEL,
    color: "b60205",
    description: "Opened and closed by 1stSeen's monitoring (docs/operations.md)",
  });
}

function compose({ key, fingerprint, notifiedAt, summary, details, env }) {
  const link = runUrl(env);
  const body = [
    summary,
    "",
    details ?? "",
    "",
    `Last checked ${new Date().toISOString()}${link ? ` in [this run](${link})` : ""}. This issue closes itself when the check passes again.`,
    "What each alert means and what to do: docs/operations.md.",
    "",
    marker("key", key),
    marker("fingerprint", fingerprint),
    marker("notified", notifiedAt),
  ].join("\n");
  return redact(body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n(truncated)` : body, env);
}

/**
 * Opens the issue for `key`, or updates it. `state` is a short description of what is wrong (for example the list of
 * failing checks); a change in it notifies, a repeat does not, except once a day as a reminder.
 * Returns what it did: "opened", "notified", "updated", or "not_configured".
 */
export async function raiseAlert({ key, title, summary, details, state, env = process.env }) {
  const github = client(env);
  if (!github) return "not_configured";
  const fingerprint = createHash("sha256").update(String(state ?? summary)).digest("hex").slice(0, 16);
  const now = new Date().toISOString();
  const existing = await findOpen(github, key);

  if (!existing) {
    await ensureLabel(github);
    // The repository owner: an assignment is what GitHub Mobile pushes for, beside the email every watcher gets.
    const assignee = env.GITHUB_REPOSITORY_OWNER;
    const issue = { title: redact(title, env), body: compose({ key, fingerprint, notifiedAt: now, summary, details, env }), labels: [ALERT_LABEL] };
    try {
      await github("POST", "/issues", assignee ? { ...issue, assignees: [assignee] } : issue);
    } catch (error) {
      // An organisation owner cannot be assigned; the issue still goes to everyone watching the repository.
      if (error.status !== 422 || !assignee) throw error;
      await github("POST", "/issues", issue);
    }
    return "opened";
  }

  const changed = readMarker(existing.body, "fingerprint") !== fingerprint;
  const lastNotified = Date.parse(readMarker(existing.body, "notified") ?? "") || 0;
  const remind = Date.now() - lastNotified > REMIND_AFTER_MS;
  const notify = changed || remind;
  await github("PATCH", `/issues/${existing.number}`, {
    title: redact(title, env),
    body: compose({ key, fingerprint, notifiedAt: notify ? now : new Date(lastNotified).toISOString(), summary, details, env }),
  });
  if (notify) {
    const link = runUrl(env);
    await github("POST", `/issues/${existing.number}/comments`, {
      body: redact(`${changed ? "Changed" : "Still failing"}: ${summary}${link ? `\n\n[Run](${link})` : ""}`, env),
    });
    return "notified";
  }
  return "updated";
}

/** Closes the open issue for `key`, if any, with a comment. Returns "resolved", "none_open", or "not_configured". */
export async function resolveAlert({ key, summary, env = process.env }) {
  const github = client(env);
  if (!github) return "not_configured";
  const existing = await findOpen(github, key);
  if (!existing) return "none_open";
  const link = runUrl(env);
  await github("POST", `/issues/${existing.number}/comments`, {
    body: redact(`Resolved: ${summary}${link ? `\n\n[Run](${link})` : ""}`, env),
  });
  await github("PATCH", `/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
  return "resolved";
}
