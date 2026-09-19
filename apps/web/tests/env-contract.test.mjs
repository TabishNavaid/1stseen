/**
 * Every environment variable the code reads is documented, catalogued, and safe.
 *
 * Scans what actually reads configuration (the web app, shared package, Node scripts, the
 * worker's typed Settings, deploy-script inputs, and workflow vars and secrets) and checks
 * each name against .env.example and scripts/lib/env-catalog.mjs, which `npm run preflight`
 * validates. A variable nobody documented must fail here, not in production.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIONS_ONLY_VARIABLES, DEPLOY_PARAMETERS, ENV_CATALOG, TOOLING_VARIABLES } from "../../../scripts/lib/env-catalog.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir, extensions) {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".wrangler", ".vinext", "tests"].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, extensions);
    return extensions.some((extension) => name.endsWith(extension)) ? [path] : [];
  });
}

function collect(files, pattern, found = new Map()) {
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const name = match.slice(1).find(Boolean);
      found.set(name, [...(found.get(name) ?? []), relative(ROOT, file)]);
    }
  }
  return found;
}

/** Names read by running code or passed to the deploy scripts. */
const read = collect(
  [
    ...walk(join(ROOT, "apps/web/app"), [".ts", ".tsx"]),
    ...walk(join(ROOT, "apps/web/lib"), [".ts", ".tsx"]),
    ...walk(join(ROOT, "apps/web/components"), [".ts", ".tsx"]),
    ...walk(join(ROOT, "apps/web/cloudflare"), [".ts"]),
    join(ROOT, "apps/web/vite.config.ts"),
    ...walk(join(ROOT, "packages/shared/src"), [".ts"]),
    ...walk(join(ROOT, "scripts"), [".mjs"]),
  ],
  /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
);
collect([join(ROOT, "worker/src/firstseen/config.py")], /alias="([A-Z][A-Z0-9_]*)"/g, read);
// Shell inputs: `${NAME:-default}`, `${NAME:?message}`, `${NAME+x}`. Plain `$NAME` is script-local.
collect(
  [...readdirSync(join(ROOT, "scripts")).filter((name) => name.endsWith(".sh")).map((name) => join(ROOT, "scripts", name)), join(ROOT, "worker/Dockerfile")],
  /\$\{([A-Z][A-Z0-9_]*):?[-?=+]/g,
  read,
);
const workflowsDir = join(ROOT, ".github/workflows");
const workflowNames = collect(
  readdirSync(workflowsDir).filter((name) => name.endsWith(".yml")).map((name) => join(workflowsDir, name)),
  /\b(?:vars|secrets)\.([A-Z][A-Z0-9_]*)/g,
);

const exampleNames = new Set(
  [...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
);
const catalogNames = new Set(ENV_CATALOG.map((entry) => entry.name));
const deployNames = new Set(Object.keys(DEPLOY_PARAMETERS));
const productNames = [...read.keys()].filter((name) => !(name in TOOLING_VARIABLES));
const where = (name) => `${name} (${read.get(name)?.[0] ?? workflowNames.get(name)?.[0]})`;

test("the scan finds variables from every kind of reader (guards against a broken scanner)", () => {
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_DB_URL", "MAX_SOURCE_BYTES", "WEB_DOMAIN", "PROJECT_ID"]) {
    assert.ok(read.has(name), `${name} was not found by the scan`);
  }
  assert.ok(workflowNames.has("SUPABASE_SERVICE_ROLE_KEY"));
});

test("every variable the code reads is in .env.example", () => {
  const missing = productNames.filter((name) => !exampleNames.has(name));
  assert.deepEqual(missing, [], `add to .env.example (commented out if it has no safe default): ${missing.map(where).join(", ")}`);
});

test("every variable the code reads is in the preflight catalog or is a deploy-script input", () => {
  const missing = productNames.filter((name) => !catalogNames.has(name) && !deployNames.has(name));
  assert.deepEqual(missing, [], `add to scripts/lib/env-catalog.mjs: ${missing.map(where).join(", ")}`);
});

test("every workflow variable and secret is catalogued", () => {
  const missing = [...workflowNames.keys()].filter(
    (name) => !catalogNames.has(name) && !(name in ACTIONS_ONLY_VARIABLES) && !(name in TOOLING_VARIABLES),
  );
  assert.deepEqual(missing, [], `catalogue these workflow names: ${missing.map(where).join(", ")}`);
});

test("the catalog has no stale entries", () => {
  const stale = [...catalogNames, ...deployNames].filter((name) => !read.has(name));
  assert.deepEqual(stale, [], `catalogued but never read: ${stale.join(", ")}`);
  for (const name of Object.keys(ACTIONS_ONLY_VARIABLES)) {
    assert.ok(workflowNames.has(name), `${name} is listed as Actions-only but no workflow uses it`);
    assert.ok(!read.has(name), `${name} is listed as Actions-only but code reads it`);
  }
});

test("secrets are never NEXT_PUBLIC_, and the two server-only credentials are marked secret", () => {
  for (const entry of ENV_CATALOG) {
    if (entry.secret) assert.ok(!entry.name.startsWith("NEXT_PUBLIC_"), `${entry.name} is secret but would be inlined into the browser bundle`);
    assert.ok(["required", "feature", "tuning"].includes(entry.group), `${entry.name} has no group`);
    assert.ok(entry.absent, `${entry.name} does not say what breaks without it`);
  }
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "AGENT_API_BEARER_TOKEN", "SUPABASE_DB_URL"]) {
    assert.equal(ENV_CATALOG.find((entry) => entry.name === name).secret, true, `${name} must be marked secret`);
  }
});

test(".env.example carries no secret values", () => {
  const secrets = new Set(ENV_CATALOG.filter((entry) => entry.secret).map((entry) => entry.name));
  for (const match of readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    if (secrets.has(match[1])) assert.equal(match[2].trim(), "", `${match[1]} has a value in .env.example`);
  }
});

test("catalog checks accept good values and reject the dangerous ones", () => {
  const entry = (name) => ENV_CATALOG.find((item) => item.name === name);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (role) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role })}.c2lnbmF0dXJl`;
  const production = { env: {}, production: true };
  const development = { env: {}, production: false };

  assert.equal(entry("NEXT_PUBLIC_SUPABASE_ANON_KEY").check(jwt("anon"), development), null);
  assert.equal(entry("NEXT_PUBLIC_SUPABASE_ANON_KEY").check("sb_publishable_abc", development), null);
  assert.match(entry("NEXT_PUBLIC_SUPABASE_ANON_KEY").check(jwt("service_role"), development), /browser bundle/);
  assert.match(entry("NEXT_PUBLIC_SUPABASE_ANON_KEY").check("sb_secret_abcdef", development), /browser bundle/);
  assert.equal(entry("SUPABASE_SERVICE_ROLE_KEY").check(jwt("service_role"), development), null);
  assert.match(entry("SUPABASE_SERVICE_ROLE_KEY").check(jwt("anon"), development), /not a service_role/);
  assert.match(entry("FIRSTSEEN_DEMO_MODE").check("false", production), /unset in production/);
  assert.match(entry("FIRSTSEEN_ENV").check("development", production), /production/);
  assert.match(entry("NEXT_PUBLIC_APP_URL").check("http://firstseen.example", production), /https/);
  assert.match(entry("NEXT_PUBLIC_APP_URL").check("https://firstseen.example/", production), /bare origin/);
  assert.match(entry("ALLOW_UNAUTHENTICATED_AGENT_DEV").check("true", production), /not be true/);
  assert.match(entry("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY").check("short", development), /32 random bytes/);
  assert.equal(entry("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY").check(Buffer.alloc(32, 7).toString("base64url"), development), null);
  assert.match(
    entry("GOOGLE_CALENDAR_REDIRECT_URI").check("https://other.example/api/integrations/google-calendar/callback", { env: { NEXT_PUBLIC_APP_URL: "https://firstseen.example" }, production: true }),
    /match NEXT_PUBLIC_APP_URL/,
  );
  assert.match(entry("MAX_SOURCE_BYTES").check("20000000", development), /10000 to 10000000/);
  assert.match(entry("LLM_EXTRACT_ROUTES").check("gemini/gemini-2.5-flash", development), /GEMINI_API_KEY/);
  assert.match(entry("LLM_EXTRACT_ROUTES").check("openai/gpt-5", development), /gemini\/<model>/);
  assert.match(entry("REDDIT_API_ENABLED").check("true", development), /refuses to start/);
});
