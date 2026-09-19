/**
 * scripts/deploy-agent.sh stores its two secrets only when the pasted value is valid, never
 * puts a value on a command line, and leaves a secret with a usable version alone.
 *
 * Runs the real script against a stub `gcloud` on PATH that records its arguments and the
 * stdin of `secrets versions add`. Every value here is synthetic.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (role) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, ref: "synthetic" })}.c2lnbmF0dXJl`;
const SERVICE_KEY = jwt("service_role");
const TOKEN = "synthetic_bearer_token_for_tests_only_0123456789";

// `secrets versions list` prints a version only when HAS_VERSION=1; every other describe/list
// reports "not found" so the script takes its create path.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/calls.log"
case "$1 $2 $3" in
  "secrets versions list") [ "\${HAS_VERSION:-0}" = 1 ] && echo "projects/p/secrets/$4/versions/1"; exit 0 ;;
  "secrets versions add") cat > "$STUB_DIR/stored-$4"; exit 0 ;;
esac
case "$*" in
  *" describe "*) exit 1 ;;
  "run services describe"*) echo "https://firstseen-agent-stub.a.run.app"; exit 0 ;;
esac
exit 0
`;

function deploy(stdin, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "firstseen-deploy-agent-"));
  const stub = join(dir, "gcloud");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  try {
    const result = spawnSync("bash", ["scripts/deploy-agent.sh"], {
      cwd: ROOT,
      input: stdin,
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, STUB_DIR: dir, PROJECT_ID: "synthetic-project", ...extraEnv },
    });
    const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
    // Read everything before the directory is removed below.
    const storedValues = Object.fromEntries(
      ["SUPABASE_SERVICE_ROLE_KEY", "AGENT_API_BEARER_TOKEN"].map((name) => [name, read(`stored-${name}`)]),
    );
    return { code: result.status, out: result.stdout + result.stderr, calls: read("calls.log") ?? "", stored: (name) => storedValues[name] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an empty paste stores nothing and creates no secret", () => {
  const { code, out, calls } = deploy("");
  assert.equal(code, 1);
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY was empty or malformed; nothing was stored/);
  assert.doesNotMatch(calls, /secrets create|versions add/);
});

test("an anon key pasted as the service-role key is refused before anything is created", () => {
  const { code, out, calls } = deploy(`${jwt("anon")}\n`);
  assert.equal(code, 1);
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY was empty or malformed/);
  assert.doesNotMatch(calls, /secrets create|versions add/);
});

test("a short bearer token is refused after a valid service-role key, and only the valid one is stored", () => {
  const { code, out, calls, stored } = deploy(`${SERVICE_KEY}\nshort\n`);
  assert.equal(code, 1);
  assert.match(out, /AGENT_API_BEARER_TOKEN was empty or malformed/);
  assert.equal(stored("SUPABASE_SERVICE_ROLE_KEY"), SERVICE_KEY);
  assert.equal(stored("AGENT_API_BEARER_TOKEN"), null);
  assert.doesNotMatch(calls, /secrets create AGENT_API_BEARER_TOKEN/);
});

test("valid values are stored through stdin only and never appear in arguments or output", () => {
  const { out, calls, stored } = deploy(`${SERVICE_KEY}\n${TOKEN}\n`);
  assert.equal(stored("SUPABASE_SERVICE_ROLE_KEY"), SERVICE_KEY);
  assert.equal(stored("AGENT_API_BEARER_TOKEN"), TOKEN);
  assert.match(calls, /secrets versions add SUPABASE_SERVICE_ROLE_KEY --data-file=-/);
  assert.match(calls, /secrets versions add AGENT_API_BEARER_TOKEN --data-file=-/);
  for (const value of [SERVICE_KEY, TOKEN]) {
    assert.ok(!calls.includes(value), "a secret value reached gcloud's argument list");
    assert.ok(!out.includes(value), "a secret value was printed");
  }
  // The deploy step then refuses without SUPABASE_URL, after both secrets are in place.
  assert.match(out, /set SUPABASE_URL=/);
});

test("secrets that already have an enabled version are left alone and nothing is read", () => {
  const { out, calls, stored } = deploy("", { HAS_VERSION: "1", SUPABASE_URL: "https://synthetic.supabase.co" });
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY already has an enabled version/);
  assert.match(out, /AGENT_API_BEARER_TOKEN already has an enabled version/);
  assert.doesNotMatch(calls, /secrets create|versions add/);
  assert.equal(stored("SUPABASE_SERVICE_ROLE_KEY"), null);
  assert.match(calls, /run deploy firstseen-agent/);
});
