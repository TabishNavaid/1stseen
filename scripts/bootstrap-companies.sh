#!/usr/bin/env bash
#
# Seed the hosted corpus with the approved companies: the 13 from the local validation run and
# the two company expansions that followed it.
#
# Runs `firstseen discover --company <domain>` once per company. Discovery is
# already idempotent in the repository layer — companies upsert on `domain` and
# sources upsert on (company_id, url), so IDs stay stable across runs — but this
# script additionally skips a company that already has sources so a re-run does
# not re-fetch every careers page. Pass --force to re-run discovery anyway.
#
# There are deliberately no retries: a collector never retries automatically;
# a failed company is reported and the next run picks it up.
#
# Usage:
#   scripts/bootstrap-companies.sh [--force] [--dry-run] [company-domain ...]

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Official domains. `discover` accepts a name or a domain, but a domain skips the
# ambiguous-identity path entirely and the result is still verified against real
# HTTP evidence before it is accepted, so a wrong guess fails loudly.
DEFAULT_COMPANIES=(
  cloudflare.com
  samsara.com
  stripe.com
  databricks.com
  robinhood.com
  figma.com
  duolingo.com
  gitlab.com
  notion.so
  cohere.com
  ramp.com
  spotify.com
  bosch.com
  # First company expansion: archived boards and a year in their titles.
  pdtpartners.com
  jumptrading.com
  virtu.com
  palantir.com
  canonical.com
  snowflake.com
  optiver.com
  imc.com
  drw.com
  point72.com
  lyft.com
  verkada.com
  waymo.com
  vercel.com
  neuralink.com
  dropbox.com
  # Second company expansion. rubrik.com is approved but absent: it answers the crawler with HTTP 403, so its identity
  # cannot be verified over HTTP.
  hudsonrivertrading.com
  fiverings.com
  tower-research.com
  akunacapital.com
  oldmissioncapital.com
  squarepoint-capital.com
  dvtrading.co
  belvederetrading.com
  flowtraders.com
  scale.com
  datadoghq.com
  coinbase.com
  roblox.com
  tanium.com
  replit.com
  ziphq.com
  appliedintuition.com
  commure.com
  epicgames.com
  anduril.com
  shield.ai
  westerndigital.com
  nuro.ai
  id.me
  abbvie.com
  celonis.com
  veeva.com
)

FORCE=0
DRY_RUN=0
COMPANIES=()
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown flag: $arg" >&2; exit 2 ;;
    *)         COMPANIES+=("$arg") ;;
  esac
done
[ ${#COMPANIES[@]} -eq 0 ] && COMPANIES=("${DEFAULT_COMPANIES[@]}")

# Collection bounds required for real ATS boards. The 2 MB default rejects them,
# and 1.5 s per-origin pacing is the courtesy interval used for archive-heavy runs.
export MAX_SOURCE_BYTES="${MAX_SOURCE_BYTES:-10000000}"
export HTTP_MIN_HOST_INTERVAL_SECONDS="${HTTP_MIN_HOST_INTERVAL_SECONDS:-1.5}"

FIRSTSEEN="$ROOT/.venv/bin/firstseen"
if [ ! -x "$FIRSTSEEN" ]; then
  echo "error: $FIRSTSEEN not found. Run 'make setup' first." >&2
  exit 1
fi
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  # The worker reads .env itself; this check only produces a better message.
  if [ ! -f "$ROOT/.env" ]; then
    echo "error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (export them or create .env)." >&2
    exit 1
  fi
fi

LOG_DIR="$ROOT/.bootstrap-logs"
mkdir -p "$LOG_DIR"

# Domains that already have at least one configured source, so a re-run is cheap.
already_discovered() {
  node - <<'NODE' 2>/dev/null || true
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) process.exit(0);
const headers = { apikey: key, Authorization: `Bearer ${key}` };
// PostgREST returns at most 1000 rows per response whatever the limit asks for, so page by id until a page is empty.
const domains = new Set();
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${url}/rest/v1/sources?select=id,companies(domain)&order=id&limit=1000&offset=${offset}`, { headers });
  if (!res.ok) process.exit(0);
  const rows = await res.json();
  if (rows.length === 0) break;
  for (const row of rows) if (row?.companies?.domain) domains.add(row.companies.domain);
}
process.stdout.write([...domains].join("\n"));
NODE
}

echo "1stSeen — hosted corpus bootstrap"
echo "  companies                       ${#COMPANIES[@]}"
echo "  MAX_SOURCE_BYTES                $MAX_SOURCE_BYTES"
echo "  HTTP_MIN_HOST_INTERVAL_SECONDS  $HTTP_MIN_HOST_INTERVAL_SECONDS"
echo "  force                           $FORCE"
echo

EXISTING="$(already_discovered)"

declare -a NAMES=() STATUSES=() SOURCES=() SECONDS_EACH=()
run_started=$(date +%s)

for company in "${COMPANIES[@]}"; do
  status="" count="-"
  if [ "$FORCE" -eq 0 ] && printf '%s\n' "$EXISTING" | grep -Fxq "$company"; then
    NAMES+=("$company"); STATUSES+=("skipped"); SOURCES+=("-"); SECONDS_EACH+=("0")
    printf '  %-16s skipped (already discovered)\n' "$company"
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    NAMES+=("$company"); STATUSES+=("dry-run"); SOURCES+=("-"); SECONDS_EACH+=("0")
    printf '  %-16s would run: firstseen discover --company %s\n' "$company" "$company"
    continue
  fi

  printf '  %-16s discovering... ' "$company"
  started=$(date +%s)
  log="$LOG_DIR/${company//[^a-zA-Z0-9]/_}.json"
  if "$FIRSTSEEN" discover --company "$company" > "$log" 2>&1; then
    status="ok"
    count="$(node -e '
      const fs = require("fs");
      try { const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(d.sources?.length ?? 0); }
      catch { console.log("?"); }
    ' "$log")"
  else
    status="failed"
  fi
  elapsed=$(( $(date +%s) - started ))
  NAMES+=("$company"); STATUSES+=("$status"); SOURCES+=("$count"); SECONDS_EACH+=("$elapsed")
  if [ "$status" = "ok" ]; then
    printf 'ok (%s sources, %ss)\n' "$count" "$elapsed"
  else
    printf 'FAILED (%ss) — see %s\n' "$elapsed" "${log#$ROOT/}"
  fi
done

# Greenhouse boards from the 2026-08-14 validation configuration that no company page links to
# today, so discovery cannot observe them. Each is registered only if Greenhouse's official
# board metadata endpoint names the company (`firstseen register-ats-board`); a mismatch is
# refused and reported. Discovery already finds Figma's board.
VERIFIED_GREENHOUSE_BOARDS=(
  cloudflare.com:cloudflare
  samsara.com:samsara
  stripe.com:stripe
  databricks.com:databricks
  robinhood.com:robinhood
  gitlab.com:gitlab
  duolingo.com:duolingo
  # First company expansion, each confirmed on 2026-09-14 by the board's own metadata naming the company.
  optiver.com:optiverus
  imc.com:imc
  drw.com:drweng
  lyft.com:lyft
  verkada.com:verkada
  waymo.com:waymo
  neuralink.com:neuralink
  dropbox.com:dropbox
  # Second company expansion, each confirmed on 2026-09-14 by the board's own metadata naming the company.
  hudsonrivertrading.com:wehrtyou
  tower-research.com:towerresearchcapital
  squarepoint-capital.com:squarepointcapital
  scale.com:scaleai
  datadoghq.com:datadog
  coinbase.com:coinbase
  roblox.com:roblox
  epicgames.com:epicgames
  anduril.com:andurilindustries
  nuro.ai:nuro
  id.me:idmeuniversityrecruiting
  celonis.com:celonis
)
BOARD_LINES=()
board_failures=0
if [ "$DRY_RUN" -eq 0 ]; then
  echo
  echo "Greenhouse boards (verified against official board metadata):"
  for pair in "${VERIFIED_GREENHOUSE_BOARDS[@]}"; do
    domain="${pair%%:*}" tenant="${pair#*:}"
    log="$LOG_DIR/board_${tenant}.json"
    if "$FIRSTSEEN" register-ats-board --company "$domain" --tenant "$tenant" > "$log" 2>&1; then
      BOARD_LINES+=("$(printf '  %-18s %-12s registered' "$domain" "$tenant")")
    else
      reason="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reason)}catch{console.log("see log")}' "$log")"
      BOARD_LINES+=("$(printf '  %-18s %-12s REFUSED (%s)' "$domain" "$tenant" "$reason")")
      board_failures=$((board_failures+1))
    fi
  done
  printf '%s\n' "${BOARD_LINES[@]}"
fi

total_elapsed=$(( $(date +%s) - run_started ))

echo
printf '+------------------+----------+---------+-------+\n'
printf '| %-16s | %-8s | %-7s | %-5s |\n' "COMPANY" "STATUS" "SOURCES" "SECS"
printf '+------------------+----------+---------+-------+\n'
ok=0; failed=0; skipped=0
for i in "${!NAMES[@]}"; do
  printf '| %-16s | %-8s | %-7s | %-5s |\n' "${NAMES[$i]}" "${STATUSES[$i]}" "${SOURCES[$i]}" "${SECONDS_EACH[$i]}"
  case "${STATUSES[$i]}" in
    ok)      ok=$((ok+1)) ;;
    failed)  failed=$((failed+1)) ;;
    skipped) skipped=$((skipped+1)) ;;
  esac
done
printf '+------------------+----------+---------+-------+\n'
echo
echo "discovered $ok, skipped $skipped, failed $failed, in ${total_elapsed}s"

if [ "$board_failures" -gt 0 ]; then
  echo
  echo "$board_failures Greenhouse board registration(s) were refused; see $LOG_DIR/board_*.json."
fi

if [ "$failed" -gt 0 ]; then
  echo
  echo "Discovery failed for $failed company/companies. Collectors do not retry by design;"
  echo "re-run this script to pick them up — successful companies will be skipped."
  exit 1
fi

echo
echo "Next:"
echo "  .venv/bin/firstseen ingest --all --collection current"
echo "  .venv/bin/firstseen enrich --all"
echo "  .venv/bin/firstseen regenerate-forecasts"
