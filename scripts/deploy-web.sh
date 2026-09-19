#!/usr/bin/env bash
#
# Build apps/web and deploy it to Cloudflare Workers.
#
#   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key> \
#   FIRSTSEEN_AGENT_API_URL=https://<service>.run.app \
#   WEB_DOMAIN=firstseen.tabishnavaid.dev \
#   npm run deploy:web
#
# Optional: SUPABASE_URL (defaults to NEXT_PUBLIC_SUPABASE_URL) and
# NEXT_PUBLIC_APP_URL (defaults to https://$WEB_DOMAIN). Needs `npx wrangler login`
# or CLOUDFLARE_API_TOKEN first.
#
# --------------------------------------------------------------------------
# Deploy path
# --------------------------------------------------------------------------
# No checked-in wrangler config. The Cloudflare Vite plugin writes a complete one to
# apps/web/dist/server/wrangler.json on every build (Worker `firstseen-web`, assets
# ../client, nodejs_compat), and `wrangler deploy --config` on that file uploads the
# Worker and the client assets together. Verified with `wrangler deploy --dry-run`.
#
# --------------------------------------------------------------------------
# Where each value lives
# --------------------------------------------------------------------------
# Build time: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_APP_URL
#   vinext inlines NEXT_PUBLIC_* during `npm run build`.
#   Every auth call runs in the Worker's /api/auth routes, so these land in the server
#   bundle, not the browser's; the inspection below fails if the anon key reaches the
#   client bundle. They still come only from the artifact: a Worker var set later is ignored.
#   Rotating the anon key means running this script again, not `wrangler secret put`.
#   All three are exported explicitly because Vite also loads the root .env, whose
#   development values (localhost) would otherwise be folded into the build.
#
# Runtime vars: SUPABASE_URL, FIRSTSEEN_ENV=production, FIRSTSEEN_AGENT_API_URL, NEXT_PUBLIC_APP_URL
#   Passed with --var. `wrangler deploy` replaces plain vars wholesale, so this script
#   is their only source. NEXT_PUBLIC_APP_URL is set at runtime too so the dashboard
#   and the artifact agree.
#
# Optional runtime vars: FIRSTSEEN_CONTACT_EMAIL, ROBOTS_TXT_ENFORCED
#   Passed with --var when set, for the same reason. Unset, /contact says no contact address is
#   configured and /data-sources says collection does not check robots.txt (docs/takedown.md).
#
# Secrets: SUPABASE_SERVICE_ROLE_KEY, AGENT_API_BEARER_TOKEN
#   Removed from the build environment and never put on argv. Set once from stdin;
#   they persist across deploys and this script checks that they exist:
#     npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name firstseen-web
#     npx wrangler secret put AGENT_API_BEARER_TOKEN --name firstseen-web
#
# FIRSTSEEN_DEMO_MODE stays unset, not "false": the script refuses to run with it in
# the environment and fails if the Worker holds it as a secret.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKER_NAME="firstseen-web"
CONFIG="apps/web/dist/server/wrangler.json"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
export WRANGLER_SEND_METRICS=false

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -x "$WRANGLER" ] || die "wrangler not found. Run 'npm ci' at the repository root."

# ------------------------------------------------------------- validate input
[ -z "${FIRSTSEEN_DEMO_MODE+x}" ] || die "FIRSTSEEN_DEMO_MODE is set. Production must leave it unset, not 'false'."

: "${NEXT_PUBLIC_SUPABASE_URL:?set NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY (Supabase: Project Settings -> API -> anon public)}"
: "${FIRSTSEEN_AGENT_API_URL:?set FIRSTSEEN_AGENT_API_URL to the Cloud Run service URL printed by scripts/deploy-agent.sh}"
: "${WEB_DOMAIN:?set WEB_DOMAIN, e.g. firstseen.tabishnavaid.dev}"
SUPABASE_URL="${SUPABASE_URL:-$NEXT_PUBLIC_SUPABASE_URL}"
NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-https://$WEB_DOMAIN}"

for pair in "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL" "SUPABASE_URL=$SUPABASE_URL" \
            "FIRSTSEEN_AGENT_API_URL=$FIRSTSEEN_AGENT_API_URL" "NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL"; do
  name="${pair%%=*}" value="${pair#*=}"
  [[ "$value" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || die "$name must be a bare https origin with no path or trailing slash (got a value that is not)"
done

# The anon key is inlined into public JavaScript. A service-role key here would be
# published to every visitor, so refuse anything that looks like one.
node - "$NEXT_PUBLIC_SUPABASE_ANON_KEY" <<'NODE' || die "NEXT_PUBLIC_SUPABASE_ANON_KEY is not an anon key. Refusing to inline it into the browser bundle."
const key = process.argv[2];
if (key.startsWith("sb_secret_")) process.exit(1);
const parts = key.split(".");
if (parts.length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.role !== "anon") process.exit(1);
  } catch { process.exit(1); }
}
if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY === key) process.exit(1);
NODE

echo "worker      $WORKER_NAME"
echo "domain      $WEB_DOMAIN"
echo "app url     $NEXT_PUBLIC_APP_URL"

# `wrangler whoami` exits 0 even when unauthenticated, so read what it says.
WHOAMI="$("$WRANGLER" whoami 2>&1 || true)"
if printf '%s' "$WHOAMI" | grep -Eqi 'not authenticated|CLOUDFLARE_API_TOKEN'; then
  die "not logged in to Cloudflare. Run: npx wrangler login"
fi

# --------------------------------------------------------------------- build
step "Build (NEXT_PUBLIC_* inlined now)"
env -u SUPABASE_SERVICE_ROLE_KEY -u AGENT_API_BEARER_TOKEN -u SUPABASE_DB_URL \
  NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
  npm run build

# ------------------------------------------------------ inspect the artifact
step "Inspect the build output"
node - <<'NODE' || die "build output failed inspection; nothing was deployed"
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "./scripts/lib/db.mjs";

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const text = (files) => files.filter((f) => /\.(m?js|html|json|css|map)$/.test(f)).map((f) => [f, readFileSync(f, "utf8")]);
const client = text(walk("apps/web/dist/client"));
const everything = text(walk("apps/web/dist"));
let failed = false;
const check = (ok, message) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${message}`); if (!ok) failed = true; };

const server = text(walk("apps/web/dist/server"));
check(server.some(([, body]) => body.includes(process.env.NEXT_PUBLIC_SUPABASE_URL)),
  "Supabase URL is inlined into the server bundle (sign-in depends on it)");
check(!client.some(([, body]) => body.includes(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)),
  "anon key is absent from the client bundle (every auth call runs on the server)");
check(!client.some(([, body]) => /process\.env/.test(body)), "no client chunk reads process.env");

// Secret values the operator holds locally must not appear anywhere in dist/.
loadDotEnv();
for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "AGENT_API_BEARER_TOKEN", "SUPABASE_DB_URL"]) {
  const value = process.env[name];
  if (!value || value.length < 12) { console.log(`  SKIP  ${name}: no local value to search for`); continue; }
  const hit = everything.find(([, body]) => body.includes(value));
  check(!hit, `${name} value absent from dist/${hit ? ` (found in ${hit[0]})` : ""}`);
}

// Any JWT in client code must be an anon token.
for (const [file, body] of client) {
  for (const [token] of body.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
    let role = "unparseable";
    try { role = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).role ?? "none"; } catch {}
    check(role === "anon", `JWT in ${file} has role ${role}`);
  }
}
process.exit(failed ? 1 : 0);
NODE

# -------------------------------------------------------------------- deploy
step "Deploy"
OPTIONAL_VARS=()
if [ -n "${FIRSTSEEN_CONTACT_EMAIL:-}" ]; then OPTIONAL_VARS+=(--var "FIRSTSEEN_CONTACT_EMAIL:$FIRSTSEEN_CONTACT_EMAIL"); fi
if [ -n "${ROBOTS_TXT_ENFORCED:-}" ]; then OPTIONAL_VARS+=(--var "ROBOTS_TXT_ENFORCED:$ROBOTS_TXT_ENFORCED"); fi
"$WRANGLER" deploy --config "$CONFIG" \
  --var "SUPABASE_URL:$SUPABASE_URL" \
  --var "FIRSTSEEN_ENV:production" \
  --var "FIRSTSEEN_AGENT_API_URL:$FIRSTSEEN_AGENT_API_URL" \
  --var "NEXT_PUBLIC_APP_URL:$NEXT_PUBLIC_APP_URL" \
  ${OPTIONAL_VARS[@]+"${OPTIONAL_VARS[@]}"} \
  --domain "$WEB_DOMAIN"

# ------------------------------------------------------------------- secrets
step "Worker secrets"
SECRETS="$("$WRANGLER" secret list --name "$WORKER_NAME" --format json)"
missing=0
for name in SUPABASE_SERVICE_ROLE_KEY AGENT_API_BEARER_TOKEN; do
  if printf '%s' "$SECRETS" | grep -q "\"$name\""; then
    echo "  present  $name"
  else
    echo "  MISSING  $name   ->  npx wrangler secret put $name --name $WORKER_NAME"
    missing=1
  fi
done
if printf '%s' "$SECRETS" | grep -q '"FIRSTSEEN_DEMO_MODE"'; then
  die "the Worker holds a FIRSTSEEN_DEMO_MODE secret. Delete it: npx wrangler secret delete FIRSTSEEN_DEMO_MODE --name $WORKER_NAME"
fi

# -------------------------------------------------------------- live checks
step "Live checks against $NEXT_PUBLIC_APP_URL"
BODY="$(mktemp)"; HEADERS="$(mktemp)"
trap 'rm -f "$BODY" "$HEADERS"' EXIT
status="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' "$NEXT_PUBLIC_APP_URL/" || echo 000)"
echo "  HTTP $status"
grep -qi '^content-security-policy:' "$HEADERS" && echo "  PASS  CSP header present" || echo "  FAIL  CSP header missing"
grep -qi '^strict-transport-security:' "$HEADERS" && echo "  PASS  HSTS header present" || echo "  FAIL  HSTS header missing"
if grep -Eiq 'Development fixture|northstar|meridian|\.example[/"<[:space:]]' "$BODY"; then
  echo "  FAIL  fixture markers found in the dashboard HTML"
else
  echo "  PASS  no fixture markers in the dashboard HTML"
fi
if grep -q 'Not configured' "$BODY"; then
  echo "  WARN  dashboard reports 'Not configured': the service-role secret is missing or wrong"
fi
[ "$status" = "000" ] && echo "  note  a new custom domain can take a few minutes for its certificate"

[ "$missing" -eq 0 ] || { echo; echo "Set the missing secrets above, then re-run the live checks."; exit 1; }
echo
echo "Deployed $WORKER_NAME to https://$WEB_DOMAIN"
