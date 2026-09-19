#!/usr/bin/env bash
#
# The local development rig: Supabase (Postgres, auth, Inbucket), Ollama, the agent
# API, and the web dev server. docs/local-development.md is the walkthrough.
#
#   scripts/local-rig.sh up       start Supabase, apply migrations, write .env
#   scripts/local-rig.sh env      (re)write the local connection values into .env
#   scripts/local-rig.sh agent    run the agent API on 127.0.0.1:8000 (foreground)
#   scripts/local-rig.sh doctor   check every component is reachable
#   scripts/local-rig.sh down     stop Supabase, keeping its data
#
# Secrets are written to .env (gitignored) and never printed. `supabase status`
# prints keys, so this script reads it as JSON and reports only URLs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUPABASE_CLI_VERSION="2.117.0"
supabase() { npx --yes "supabase@${SUPABASE_CLI_VERSION}" "$@"; }

AGENT_HOST="127.0.0.1"
AGENT_PORT="8000"
OLLAMA_URL="http://127.0.0.1:11434"
OLLAMA_MODEL="qwen2.5:7b"

die() { echo "error: $*" >&2; exit 1; }

write_env() {
  [ -f .env ] || cp .env.example .env
  supabase status -o json 2>/dev/null | node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { randomBytes } from "node:crypto";
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const start = raw.indexOf("{");
    if (start < 0) { console.error("supabase status returned no JSON; is the stack running?"); process.exit(1); }
    const status = JSON.parse(raw.slice(start));
    const need = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL"];
    for (const key of need) if (!status[key]) { console.error(`supabase status is missing ${key}`); process.exit(1); }

    let text = readFileSync(".env", "utf8");
    const current = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim();
    const set = (name, value) => {
      const line = `${name}=${value}`;
      const live = new RegExp(`^${name}=.*$`, "m");
      const commented = new RegExp(`^#\\s*${name}=.*$`, "m");
      if (live.test(text)) text = text.replace(live, line);
      else if (commented.test(text)) text = text.replace(commented, line);
      else text = `${text.replace(/\n?$/, "\n")}${line}\n`;
      console.log(`  set ${name}`);
    };

    set("SUPABASE_URL", status.API_URL);
    set("NEXT_PUBLIC_SUPABASE_URL", status.API_URL);
    set("NEXT_PUBLIC_SUPABASE_ANON_KEY", status.ANON_KEY);
    set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);
    set("SUPABASE_DB_URL", status.DB_URL);
    set("FIRSTSEEN_AGENT_API_URL", "http://127.0.0.1:8000");
    set("MAX_SOURCE_BYTES", "10000000");
    // Keep an existing local token so a running agent service and web server still agree.
    if (!current("AGENT_API_BEARER_TOKEN")) set("AGENT_API_BEARER_TOKEN", randomBytes(32).toString("base64url"));
    writeFileSync(".env", text);
  '
}

case "${1:-}" in
  up)
    command -v docker >/dev/null || die "Docker is required for local Supabase."
    # `supabase start` prints API keys and the database URL; keep them out of the terminal and any log.
    supabase start 2>&1 | grep --line-buffered -viE 'key|secret|jwt|password|postgres(ql)?://'
    echo
    echo "Writing local connection values to .env (values not shown):"
    write_env
    ;;
  env)
    write_env
    ;;
  agent)
    [ -x .venv/bin/uvicorn ] || die "uvicorn missing. Run: .venv/bin/pip install -e 'worker[api]'"
    exec .venv/bin/uvicorn firstseen.agent_api:app --host "$AGENT_HOST" --port "$AGENT_PORT"
    ;;
  doctor)
    ok() { printf '  %-5s %s\n' "$1" "$2"; }
    supabase status -o json 2>/dev/null | node --input-type=module -e '
      let raw = ""; for await (const c of process.stdin) raw += c;
      const s = JSON.parse(raw.slice(Math.max(0, raw.indexOf("{"))) || "{}");
      for (const k of ["API_URL", "DB_URL", "STUDIO_URL", "INBUCKET_URL", "MAILPIT_URL"]) {
        if (!s[k]) continue;
        const safe = k === "DB_URL" ? s[k].replace(/\/\/[^@]*@/, "//***@") : s[k];
        console.log(`  up    ${k.padEnd(12)} ${safe}`);
      }
    ' || ok "DOWN" "Supabase (run: scripts/local-rig.sh up)"
    if curl -sf -m 3 "$OLLAMA_URL/api/tags" | grep -q "\"$OLLAMA_MODEL\""; then ok "up" "Ollama with $OLLAMA_MODEL"; else ok "DOWN" "Ollama or $OLLAMA_MODEL (run: ollama serve; ollama pull $OLLAMA_MODEL)"; fi
    if curl -sf -m 3 "http://$AGENT_HOST:$AGENT_PORT/healthz" >/dev/null; then ok "up" "agent API http://$AGENT_HOST:$AGENT_PORT"; else ok "DOWN" "agent API (run: scripts/local-rig.sh agent)"; fi
    if curl -s -m 5 -o /dev/null http://localhost:3000/; then ok "up" "web http://localhost:3000"; else ok "DOWN" "web (run: npm run dev)"; fi
    ;;
  down)
    supabase stop
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
