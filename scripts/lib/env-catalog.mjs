import { readFileSync } from "node:fs";

/**
 * Every environment variable 1stSeen reads, in one place.
 *
 * `npm run preflight` validates an environment against this catalog, and
 * apps/web/tests/env-contract.test.mjs fails when code reads a variable that is missing
 * here or from .env.example, so a required variable is never discovered as a 500.
 *
 * Each entry:
 *   group                "required" | "feature" | "tuning"
 *   feature              the capability it belongs to (feature and tuning groups)
 *   secret               never printed, never NEXT_PUBLIC_, never a repository variable
 *   places               where it is set in production
 *   absent               one line: what breaks, or what happens, without it
 *   check(value, ctx)    a problem string, or null when the value is acceptable;
 *                        ctx = { env, production }
 *   optionalInGroup      a feature entry that is not needed to turn the feature on
 *   blankIsFatal         worker Settings types it as a URL, number, or boolean, so a
 *                        present-but-blank line stops every worker command at startup
 *   developmentDefault   missing is fine outside production
 *   requiredInProduction a required entry that may be missing outside production (no default)
 *   presetInExample      .env.example ships a working local value, so being set alone does
 *                        not mean anyone started configuring the feature
 *   mustBeAbsentInProduction
 */

const isUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
const origin = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};
const jwtRole = (value) => {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
};
const blank = (env, name) => !env[name] || !env[name].trim();

const url = ({ httpsInProduction = true, bareOrigin = false } = {}) => (value, { production }) => {
  if (!isUrl(value)) return "not an absolute http(s) URL";
  if (production && httpsInProduction && !value.startsWith("https://")) return "must be https in production";
  if (bareOrigin && origin(value) !== value) return "must be a bare origin: scheme and host, no path or trailing slash";
  return null;
};
const bool = (value) => (value === "true" || value === "false" ? null : 'must be "true" or "false"');
const intIn = (min, max) => (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? null : `must be an integer from ${min} to ${max}`;
};
const numberIn = (min, max) => (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? null : `must be a number from ${min} to ${max}`;
};
const key32 = (value) =>
  /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").byteLength === 32
    ? null
    : "must be 32 random bytes as base64url: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='";
const googleClientId = (value) =>
  value.endsWith(".apps.googleusercontent.com") ? null : "does not look like a Google OAuth client ID (…apps.googleusercontent.com)";
const routes = (value, { env }) => {
  const list = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (list.some((route) => !/^(gemini|groq|ollama)\/\S+$/.test(route))) {
    return "every route must be gemini/<model>, groq/<model>, or ollama/<model>";
  }
  for (const [provider, key] of [["gemini", "GEMINI_API_KEY"], ["groq", "GROQ_API_KEY"]]) {
    if (list.some((route) => route.startsWith(`${provider}/`)) && blank(env, key)) {
      return `names a ${provider}/ route but ${key} is not set, so that route always fails`;
    }
  }
  return null;
};
const redirect = (path) => (value, { env, production }) => {
  if (!isUrl(value)) return "not an absolute http(s) URL";
  if (new URL(value).pathname !== path) return `path must be ${path}`;
  if (production && !value.startsWith("https://")) return "must be https in production";
  const app = !blank(env, "NEXT_PUBLIC_APP_URL") && origin(env.NEXT_PUBLIC_APP_URL);
  if (app && origin(value) !== app) return "origin must match NEXT_PUBLIC_APP_URL";
  return null;
};

const CALENDAR = "Google Calendar sync";
const GMAIL = "Gmail digest delivery";
const MODELS = "Model-assisted extraction";
const REDDIT = "Reddit signals";
const VERIFY = "Database verification tooling";
const COLLECTION = "Collection";
const AGENT = "Agent API";
const MONITORING = "Production health checks";

export const ENV_CATALOG = [
  // ---------------------------------------------------------------------- required
  {
    name: "SUPABASE_URL", group: "required", secret: false, blankIsFatal: true,
    places: ["Cloudflare Worker var", "Cloud Run env var", "GitHub Actions secret"],
    absent: "Every page shows Live data is not configured; worker commands have no database.",
    check: url(),
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY", group: "required", secret: true,
    places: ["Cloudflare Worker secret", "GCP Secret Manager", "GitHub Actions secret"],
    absent: "Every page shows Live data is not configured; collection, forecasts, and the agent API cannot read or write evidence.",
    check: (value, { env }) => {
      if (value === env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return "is the same value as the anon key";
      if (value.startsWith("sb_secret_")) return null;
      const role = jwtRole(value);
      return role === "service_role" ? null : `is not a service_role key (role: ${role ?? "unreadable"})`;
    },
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_URL", group: "required", secret: false,
    places: ["Build environment of npm run deploy:web (inlined into the bundle)"],
    absent: "Sign-in shows Supabase authentication is not configured; the value is fixed when the Worker is built.",
    check: (value, ctx) => {
      const problem = url()(value, ctx);
      if (problem) return problem;
      if (!blank(ctx.env, "SUPABASE_URL") && origin(ctx.env.SUPABASE_URL) !== origin(value)) return "is a different project from SUPABASE_URL";
      return null;
    },
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", group: "required", secret: false,
    places: ["Build environment of npm run deploy:web (inlined into the bundle)"],
    absent: "Sign-in shows Supabase authentication is not configured; the value is fixed when the Worker is built.",
    check: (value) => {
      if (value.startsWith("sb_secret_")) return "is a secret key, and this value is published in the browser bundle";
      if (value.startsWith("sb_publishable_")) return null;
      const role = jwtRole(value);
      return role === "anon" ? null : `is not an anon key (role: ${role ?? "unreadable"}), and this value is published in the browser bundle`;
    },
  },
  {
    name: "NEXT_PUBLIC_APP_URL", group: "required", secret: false, developmentDefault: "http://localhost:3000",
    places: ["Build environment of npm run deploy:web, and Worker var (the script sets both)"],
    absent: "Links in digests point at http://localhost:3000.",
    check: url({ bareOrigin: true }),
  },
  {
    name: "FIRSTSEEN_AGENT_API_URL", group: "required", secret: false,
    places: ["Cloudflare Worker var"],
    absent: "Forecast Replay, the recruiting agent, and Generate preparation plan each say their service is not configured.",
    check: url({ bareOrigin: true }),
  },
  {
    name: "AGENT_API_BEARER_TOKEN", group: "required", secret: true,
    places: ["Cloudflare Worker secret", "GCP Secret Manager (same value)"],
    absent: "The same three features are unavailable, and the agent API refuses to start with FIRSTSEEN_ENV=production.",
    check: (value) => (/^[A-Za-z0-9_-]{32,}$/.test(value) ? null : "must be at least 32 base64url characters: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='"),
  },
  {
    name: "FIRSTSEEN_ENV", group: "required", secret: false, developmentDefault: "development",
    places: ["Cloudflare Worker var", "Cloud Run env var (GitHub Actions leaves it unset)"],
    absent: "Defaults to development, where the agent API does not insist on its bearer token.",
    check: (value, { production }) => {
      if (!["development", "production"].includes(value)) return 'must be "development" or "production"';
      return production && value !== "production" ? 'must be "production" for a production deploy' : null;
    },
  },
  {
    name: "FIRSTSEEN_CONTACT_EMAIL", group: "required", secret: false, requiredInProduction: true,
    places: ["Cloudflare Worker var"],
    absent: "/contact says no contact address is configured, and the terms, privacy, and data-source pages point there, so nobody can reach the operator or ask for removal.",
    check: (value) => (/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(value) ? null : "must be one plain email address"),
  },
  {
    name: "FIRSTSEEN_DEMO_MODE", group: "required", secret: false, mustBeAbsentInProduction: true,
    places: ["Nowhere in production"],
    absent: "Correct: fixture data is unreachable.",
    check: (value, { production }) => (production ? 'must be unset in production, not even "false"' : bool(value)),
  },

  // ---------------------------------------------------------------------- features
  { name: "GOOGLE_CALENDAR_CLIENT_ID", group: "feature", feature: CALENDAR, secret: false, places: ["Cloudflare Worker secret"], absent: "/calendar says Google Calendar is not configured for this environment.", check: googleClientId },
  { name: "GOOGLE_CALENDAR_CLIENT_SECRET", group: "feature", feature: CALENDAR, secret: true, places: ["Cloudflare Worker secret"], absent: "Calendar sync stays off.", check: (value) => (value.length >= 10 ? null : "is too short to be an OAuth client secret") },
  { name: "GOOGLE_CALENDAR_REDIRECT_URI", group: "feature", presetInExample: true, feature: CALENDAR, secret: false, places: ["Cloudflare Worker secret"], absent: "Calendar sync stays off.", check: redirect("/api/integrations/google-calendar/callback") },
  { name: "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY", group: "feature", feature: CALENDAR, secret: true, places: ["Cloudflare Worker secret"], absent: "Calendar sync stays off.", check: key32 },

  { name: "GMAIL_OAUTH_CLIENT_ID", group: "feature", feature: GMAIL, secret: false, places: ["Cloudflare Worker secret"], absent: "/digests previews still work; the Gmail panel says Gmail OAuth is not configured.", check: googleClientId },
  { name: "GMAIL_OAUTH_CLIENT_SECRET", group: "feature", feature: GMAIL, secret: true, places: ["Cloudflare Worker secret"], absent: "Gmail delivery stays off.", check: (value) => (value.length >= 10 ? null : "is too short to be an OAuth client secret") },
  { name: "GMAIL_OAUTH_REDIRECT_URI", group: "feature", presetInExample: true, feature: GMAIL, secret: false, places: ["Cloudflare Worker secret"], absent: "Gmail delivery stays off.", check: redirect("/api/integrations/gmail/callback") },
  { name: "EMAIL_TOKEN_ENCRYPTION_KEY", group: "feature", feature: GMAIL, secret: true, places: ["Cloudflare Worker secret"], absent: "Gmail delivery stays off.", check: key32 },
  { name: "EMAIL_DIGEST_SEND_ENABLED", group: "feature", feature: GMAIL, secret: false, optionalInGroup: true, places: ["Cloudflare Worker var"], absent: "Sending stays disabled; previews still work.", check: bool },

  { name: "LLM_MODEL", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["Cloud Run env var"], absent: "Defaults to ollama/qwen2.5:7b; with no model server reachable, model steps record a failure and deterministic results stand.", check: routes },
  { name: "LLM_DEFAULT_ROUTES", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Falls back to LLM_MODEL.", check: routes },
  { name: "LLM_EXTRACT_ROUTES", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Extraction uses the default routes.", check: routes },
  { name: "LLM_CLASSIFY_ROUTES", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Classification uses the default routes.", check: routes },
  { name: "LLM_NORMALIZE_ROUTES", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Normalization uses the default routes.", check: routes },
  { name: "LLM_REASON_ROUTES", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Reasoning uses the default routes.", check: routes },
  { name: "LLM_API_BASE", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Ollama is expected at http://localhost:11434.", check: url({ httpsInProduction: false }) },
  { name: "OLLAMA_API_BASE", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, blankIsFatal: true, places: ["local .env"], absent: "Falls back to LLM_API_BASE.", check: url({ httpsInProduction: false }) },
  { name: "LLM_API_KEY", group: "feature", feature: MODELS, secret: true, optionalInGroup: true, places: ["GitHub Actions secret"], absent: "Not needed for Ollama.", check: () => null },
  { name: "GEMINI_API_KEY", group: "feature", feature: MODELS, secret: true, optionalInGroup: true, places: ["GitHub Actions secret", "GCP Secret Manager"], absent: "gemini/ routes cannot run.", check: () => null },
  { name: "GROQ_API_KEY", group: "feature", feature: MODELS, secret: true, optionalInGroup: true, places: ["GitHub Actions secret", "GCP Secret Manager"], absent: "groq/ routes cannot run.", check: () => null },
  { name: "AGENT_INTENT_LLM_ENABLED", group: "feature", feature: MODELS, secret: false, optionalInGroup: true, blankIsFatal: true, places: ["Cloud Run env var"], absent: "The agent uses deterministic keyword intents only (the default).", check: bool },

  {
    name: "REDDIT_API_ENABLED", group: "feature", feature: REDDIT, secret: false, optionalInGroup: true, blankIsFatal: true, places: ["GitHub Actions variable"],
    absent: "Reddit signals are not collected (the default).",
    check: (value, { env }) => {
      const problem = bool(value);
      if (problem || value !== "true") return problem;
      const missing = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT", "REDDIT_COMMUNITIES"].filter((name) => blank(env, name));
      return missing.length ? `is true but ${missing.join(", ")} missing, so every worker command refuses to start` : null;
    },
  },
  { name: "REDDIT_CLIENT_ID", group: "feature", feature: REDDIT, secret: false, optionalInGroup: true, places: ["GitHub Actions secret"], absent: "Reddit collection cannot be enabled.", check: () => null },
  { name: "REDDIT_CLIENT_SECRET", group: "feature", feature: REDDIT, secret: true, optionalInGroup: true, places: ["GitHub Actions secret"], absent: "Reddit collection cannot be enabled.", check: () => null },
  { name: "REDDIT_USER_AGENT", group: "feature", feature: REDDIT, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Reddit collection cannot be enabled.", check: (value) => (value.includes("by /u/") ? null : 'must include "by /u/<account>"') },
  { name: "REDDIT_COMMUNITIES", group: "feature", feature: REDDIT, secret: false, optionalInGroup: true, places: ["GitHub Actions variable"], absent: "Reddit collection cannot be enabled.", check: (value) => (value.split(",").some((item) => item.trim()) ? null : "must name at least one community") },
  { name: "REDDIT_LLM_EXTRACTION_ENABLED", group: "feature", feature: REDDIT, secret: false, optionalInGroup: true, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Reddit text is never sent to a model (the default).", check: bool },

  {
    name: "SUPABASE_DB_URL", group: "feature", feature: VERIFY, secret: true,
    places: ["Local .env or .env.deploy", "GitHub Actions secret (the corpus backup, as the session pooler URL)"],
    absent: "npm run verify:supabase, metrics:corpus, and test:integration cannot run.",
    check: (value, { env }) => {
      if (!/^postgres(ql)?:\/\//.test(value)) return "must be a postgres:// connection string";
      // Hosted Supabase's Postgres certificate chains to Supabase's own CA, which no system trust store holds.
      const host = (() => { try { return new URL(value).hostname; } catch { return ""; } })();
      const hosted = /\.supabase\.(co|com)$/.test(host);
      if (hosted && !env.SUPABASE_DB_CA_CERT && env.SUPABASE_DB_SSL_INSECURE !== "true") {
        return "a hosted Supabase server's certificate cannot be verified without SUPABASE_DB_CA_CERT";
      }
      return null;
    },
  },
  {
    name: "SUPABASE_DB_CA_CERT", group: "feature", feature: VERIFY, secret: false, optionalInGroup: true,
    places: ["Local .env.deploy (a path outside the repository)", "GitHub Actions variable SUPABASE_DB_CA_CERT_PEM holds the certificate itself; the backup workflow writes it to a file"],
    absent: "A hosted database's certificate is checked against the system trust store, which does not hold Supabase's CA, so the connection fails.",
    check: (value) => {
      let pem;
      try {
        pem = readFileSync(value, "utf8");
      } catch (error) {
        return `must be the path of a readable file (${error.code ?? "unreadable"})`;
      }
      return pem.includes("-----BEGIN CERTIFICATE-----") ? null : "must be a PEM certificate (Supabase: Project Settings > Database > SSL Configuration)";
    },
  },
  {
    name: "FIRSTSEEN_WEB_URL", group: "feature", feature: MONITORING, secret: false,
    places: ["GitHub Actions variable"],
    absent: "The production health check reports the web app as not configured instead of probing /api/health.",
    check: (value) => (/^https:\/\/[^/\s]+$/.test(value) ? null : "must be a bare https origin"),
  },
  {
    name: "CLOUDFLARE_ACCOUNT_ID", group: "feature", feature: MONITORING, secret: false, optionalInGroup: true,
    places: ["GitHub Actions variable"],
    absent: "The health check cannot read Worker errors and CPU from Cloudflare's analytics, and says so.",
    check: (value) => (/^[0-9a-f]{32}$/.test(value) ? null : "must be a 32-character Cloudflare account id"),
  },
  {
    name: "CLOUDFLARE_ANALYTICS_TOKEN", group: "feature", feature: MONITORING, secret: true, optionalInGroup: true,
    places: ["GitHub Actions secret"],
    absent: "The health check cannot read Worker errors and CPU from Cloudflare's analytics, and says so.",
    check: () => null,
  },
  {
    name: "SUPABASE_DB_SSL_INSECURE", group: "feature", feature: VERIFY, secret: false, optionalInGroup: true, places: ["Local only, for a self-hosted server with no CA file"],
    absent: "TLS certificates are verified (the default).",
    check: (value, context) => (value === "true" && context.production ? "must not be true in production: set SUPABASE_DB_CA_CERT instead" : bool(value, context)),
  },

  // ------------------------------------------------------------------------ tuning
  { name: "MAX_SOURCE_BYTES", group: "tuning", feature: COLLECTION, secret: false, blankIsFatal: true, places: ["GitHub Actions variable (workflow fallback 10000000)"], absent: "The worker default is 2 MB, which rejects real ATS boards.", check: intIn(10_000, 10_000_000) },
  { name: "HTTP_MIN_HOST_INTERVAL_SECONDS", group: "tuning", feature: COLLECTION, secret: false, blankIsFatal: true, places: ["GitHub Actions variable (workflow fallback 0.25)"], absent: "Defaults to 0.25 s between requests to one host.", check: numberIn(0, 10) },
  { name: "HTTP_TIMEOUT_SECONDS", group: "tuning", feature: COLLECTION, secret: false, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Defaults to 20 s.", check: intIn(1, 120) },
  {
    name: "ROBOTS_TXT_ENFORCED", group: "tuning", feature: COLLECTION, secret: false, blankIsFatal: true,
    places: ["GitHub Actions variable (the three collection workflows pass it)", "Cloudflare Worker var (so /data-sources states the rule collection follows)"],
    absent: "Defaults to false: collection does not read robots.txt, and /data-sources says so. Set the same value in both places.",
    check: bool,
  },
  { name: "BROWSER_TIMEOUT_SECONDS", group: "tuning", feature: COLLECTION, secret: false, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Defaults to 30 s.", check: intIn(5, 120) },
  { name: "LLM_TIMEOUT_SECONDS", group: "tuning", feature: MODELS, secret: false, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Defaults to 30 s.", check: intIn(1, 120) },
  { name: "REDDIT_SEARCH_LIMIT", group: "tuning", feature: REDDIT, secret: false, blankIsFatal: true, places: ["GitHub Actions variable"], absent: "Defaults to 25.", check: intIn(1, 100) },
  { name: "AGENT_API_RATE_LIMIT_PER_MINUTE", group: "tuning", feature: AGENT, secret: false, blankIsFatal: true, places: ["Cloud Run env var"], absent: "Defaults to 60 requests a minute per token, per instance.", check: intIn(1, 10_000) },
  {
    name: "ALLOW_UNAUTHENTICATED_AGENT_DEV", group: "tuning", feature: AGENT, secret: false, blankIsFatal: true, places: ["Local .env only"],
    absent: "Defaults to false: agent routes require a signed-in caller.",
    check: (value, { production }) => (production && value === "true" ? "must not be true in production" : bool(value)),
  },
  { name: "COLLECTION_HEALTH_FAILURE_STREAK", group: "tuning", feature: "Collection health", secret: false, places: ["GitHub Actions variable"], absent: "Defaults to 3 consecutive failed runs.", check: intIn(1, 1_000) },
];

/** Inputs to the deploy scripts. Exported for one command; the running product never reads them. */
export const DEPLOY_PARAMETERS = {
  WEB_DOMAIN: "scripts/deploy-web.sh: the Worker's custom domain",
  PROJECT_ID: "scripts/deploy-agent.sh: GCP project, else gcloud's configured project",
  REGION: "scripts/deploy-agent.sh: Cloud Run region, default us-west1",
  SERVICE: "scripts/deploy-agent.sh: Cloud Run service, default firstseen-agent",
  REPO: "scripts/deploy-agent.sh: Artifact Registry repository, default firstseen",
  SA_NAME: "scripts/deploy-agent.sh: runtime service account, default firstseen-agent",
  BUILD_SA_NAME: "scripts/deploy-agent.sh: Cloud Build service account, default firstseen-build",
  IMAGE_TAG: "scripts/deploy-agent.sh: image tag, default the short commit",
};

/**
 * Read by build, CI, or hosting tooling rather than set by an operator. Listed so the
 * contract test can tell a deliberate exclusion from a forgotten variable.
 */
export const TOOLING_VARIABLES = {
  NODE_ENV: "set by the build",
  MINIFLARE_REGISTRY_PATH: "wrangler/miniflare state directory",
  WRANGLER_LOG_PATH: "wrangler log directory",
  WRANGLER_WRITE_LOGS: "wrangler logging switch",
  GITHUB_ACTIONS: "provided by GitHub Actions",
  GITHUB_REPOSITORY: "provided by GitHub Actions",
  GITHUB_STEP_SUMMARY: "provided by GitHub Actions",
  GITHUB_TOKEN: "provided by GitHub Actions",
  GITHUB_WORKFLOW: "provided by GitHub Actions",
  GITHUB_WORKFLOW_REF: "provided by GitHub Actions",
  GITHUB_EVENT_NAME: "provided by GitHub Actions",
  GITHUB_REPOSITORY_OWNER: "provided by GitHub Actions",
  GITHUB_SERVER_URL: "provided by GitHub Actions",
  GITHUB_RUN_ID: "provided by GitHub Actions",
  GITHUB_API_URL: "provided by GitHub Actions",
  BACKUP_PG_TOOLS: "a command prefix for pg_dump and pg_restore in scripts/backup-corpus.mjs",
  PORT: "provided by Cloud Run",
};

/** GitHub Actions variables that workflows map onto a catalogued name; no code reads them. */
export const ACTIONS_ONLY_VARIABLES = {
  COURTESY_HTTP_MIN_HOST_INTERVAL_SECONDS: "exported as HTTP_MIN_HOST_INTERVAL_SECONDS by the historical and signals workflows",
  SUPABASE_DB_CA_CERT_PEM: "Supabase's root certificate itself; the backup workflow writes it to a file and sets SUPABASE_DB_CA_CERT to that path",
  BACKUP_ENCRYPTION_PASSPHRASE: "secret: encrypts the weekly corpus backup before it is kept (the repository is public); also in the owner's password manager, without which no backup can be restored",
};
