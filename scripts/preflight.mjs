#!/usr/bin/env node
/**
 * Check an environment before running or deploying 1stSeen.
 *
 *   npm run preflight                                        .env plus exported variables
 *   npm run preflight -- --production                        production rules
 *   npm run preflight -- --production --env-file .env.deploy
 *
 * Prints every variable the product reads, grouped REQUIRED / OPTIONAL-FEATURE / TUNING,
 * with its status and what breaks without it. Values are never printed. Exits 1 when a
 * required variable is missing or malformed, or when any value that is present is
 * malformed. A partly configured optional feature is reported but does not fail.
 *
 * Production rules apply with --production or FIRSTSEEN_ENV=production: URLs must be https,
 * FIRSTSEEN_ENV must be production, and FIRSTSEEN_DEMO_MODE must be unset.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_CATALOG } from "./lib/env-catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const envFileIndex = args.indexOf("--env-file");
const envFile = envFileIndex >= 0 ? resolve(process.cwd(), args[envFileIndex + 1] ?? "") : resolve(ROOT, ".env");

/** Exported variables win over the file, as they do for the worker and the web build. */
function readEnvironment() {
  const env = {};
  let loaded = false;
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[match[1]] = value;
    }
    loaded = true;
  } catch {
    // No file: exported variables only.
  }
  for (const [name, value] of Object.entries(process.env)) env[name] = value;
  return { env, loaded };
}

const { env, loaded } = readEnvironment();
const production = args.includes("--production") || env.FIRSTSEEN_ENV === "production";
const ctx = { env, production };

const rows = ENV_CATALOG.map((entry) => {
  const raw = env[entry.name];
  if (raw !== undefined && raw.trim() === "" && entry.blankIsFatal) {
    return { entry, status: "malformed", note: "is present but blank, which stops every worker command at startup; delete or comment out the line" };
  }
  if (raw === undefined || raw.trim() === "") {
    if (entry.mustBeAbsentInProduction) return { entry, status: "unset", note: entry.absent };
    if (entry.developmentDefault && !production) return { entry, status: "default", note: `defaults to ${entry.developmentDefault} outside production` };
    if (entry.requiredInProduction && !production) return { entry, status: "optional", note: `${entry.absent} Required in production.` };
    return { entry, status: "missing", note: entry.absent };
  }
  const problem = entry.check(raw.trim(), ctx);
  return problem ? { entry, status: "malformed", note: problem } : { entry, status: "set", note: entry.secret ? "ok (secret, not shown)" : "ok" };
});

// An OAuth feature needs every one of its core variables; name what a partial setup lacks.
const features = new Map();
for (const row of rows.filter((item) => item.entry.group === "feature" && !item.entry.optionalInGroup)) {
  features.set(row.entry.feature, [...(features.get(row.entry.feature) ?? []), row]);
}
const featureState = new Map();
for (const [feature, core] of features) {
  const set = core.filter((row) => row.status === "set").length;
  const started = core.some((row) => !row.entry.presetInExample && row.status !== "missing");
  const state = set === core.length ? "on" : started ? "partial" : "off";
  featureState.set(feature, state);
  if (state !== "partial") continue;
  for (const row of core.filter((item) => item.status === "missing")) {
    row.status = "needed";
    row.note = `${feature} is partly configured and stays off until this is set`;
  }
}
featureState.set("Reddit signals", env.REDDIT_API_ENABLED === "true" ? "on" : "off");

const label = (row) => {
  if (row.status === "unset") return "unset (correct)";
  if (row.status === "optional") return "not set";
  if (row.status === "missing" && row.entry.group !== "required") return "not set";
  return row.status;
};

function printGroup(title, list) {
  const nameWidth = Math.max(...list.map((row) => row.entry.name.length));
  const statusWidth = Math.max(6, ...list.map((row) => label(row).length));
  process.stdout.write(`\n${title}\n  ${"VARIABLE".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  WHAT BREAKS WITHOUT IT / PROBLEM\n`);
  let lastFeature = null;
  for (const row of list) {
    if (title !== "REQUIRED" && row.entry.feature !== lastFeature) {
      process.stdout.write(`  · ${row.entry.feature}\n`);
      lastFeature = row.entry.feature;
    }
    process.stdout.write(`  ${row.entry.name.padEnd(nameWidth)}  ${label(row).padEnd(statusWidth)}  ${row.note}\n`);
  }
}

const source = loaded ? `${envFile} and exported variables` : "exported variables only (no env file)";
process.stdout.write(`1stSeen preflight: ${production ? "production" : "development"} rules, reading ${source}. Values are never shown.\n`);
printGroup("REQUIRED", rows.filter((row) => row.entry.group === "required"));
printGroup("OPTIONAL-FEATURE", rows.filter((row) => row.entry.group === "feature"));
printGroup("TUNING", rows.filter((row) => row.entry.group === "tuning"));

process.stdout.write(`\nFeatures: ${[...featureState].map(([feature, state]) => `${feature} ${state}`).join("; ")}\n`);
const failing = rows.filter((row) => row.status === "malformed" || (row.entry.group === "required" && row.status === "missing"));
if (failing.length) {
  process.stdout.write(`NOT READY: fix ${failing.map((row) => row.entry.name).join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("READY: every required variable is set, and every value that is present is well formed.\n");
}
