#!/usr/bin/env node
/**
 * Reports a scheduled workflow's outcome to the ops-alert issue for that workflow (scripts/lib/ops-issues.mjs).
 *
 * The last step of every collection, backtest, backup, and health-check job runs this with `if: always()`, through the
 * composite action .github/actions/ops-alert. A failed, timed-out, or cancelled run opens or updates one issue per
 * workflow; the next successful run closes it. It adds no job and so no billed minute: it is a step in a job that is
 * already running.
 *
 * Dependency-free (Node 20+, preinstalled on GitHub's runners), so no job needs `npm ci` for it. Never prints or posts a
 * credential.
 *
 * Usage: node scripts/ops-alert.mjs --status <success|failure|cancelled> [--workflow <label>]
 */

import { raiseAlert, resolveAlert, runUrl } from "./lib/ops-issues.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const status = flag("--status");
if (!["success", "failure", "cancelled"].includes(status ?? "")) {
  process.stderr.write("usage: node scripts/ops-alert.mjs --status <success|failure|cancelled> [--workflow <label>]\n");
  process.exit(2);
}

// GITHUB_WORKFLOW_REF is "owner/repo/.github/workflows/<file>@<ref>": the file name is the stable key.
const file = /\/([^/@]+\.ya?ml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? "")?.[1] ?? process.env.GITHUB_WORKFLOW ?? "unknown-workflow";
const label = flag("--workflow") || process.env.GITHUB_WORKFLOW || file;
const key = `workflow:${file}`;
const trigger = process.env.GITHUB_EVENT_NAME ?? "local";

async function main() {
  if (status === "success") {
    const outcome = await resolveAlert({ key, summary: `${label} succeeded again (${trigger}).` });
    process.stdout.write(`ops-alert: ${label} succeeded; ${outcome === "resolved" ? "closed its open alert" : outcome === "not_configured" ? "alerting not configured (no GITHUB_TOKEN)" : "no open alert"}\n`);
    return;
  }
  const what = status === "cancelled"
    ? "was cancelled: it hit its timeout, was replaced in its concurrency group, or was cancelled by hand"
    : "failed";
  const link = runUrl();
  const outcome = await raiseAlert({
    key,
    title: `Ops alert: ${label} ${status === "cancelled" ? "was cancelled" : "failed"}`,
    summary: `**${label}** ${what} (${trigger} run${link ? `, [logs](${link})` : ""}).`,
    details: [
      `Workflow file: \`.github/workflows/${file}\``,
      "",
      "Successful work before the failure is committed; collection checkpoints advance only after a fully successful pass,",
      "so the next scheduled run retries what this one missed. docs/github-actions-collection.md has the recovery table.",
    ].join("\n"),
    state: status,
  });
  process.stdout.write(`ops-alert: ${label} ${status}; issue ${outcome}\n`);
}

main().catch((error) => {
  // An undelivered alert fails the step, so the run shows red and GitHub's own failed-run email is the fallback.
  process.stderr.write(`ops-alert could not report: ${error.message}\n`);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Ops alert not delivered::${error.message}\n`);
  process.exitCode = 1;
});
