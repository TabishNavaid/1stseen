#!/usr/bin/env bash
#
# Deploy firstseen.agent_api:app to Cloud Run.
#
# Idempotent and re-runnable: every step checks for the resource before creating
# it, so a second run redeploys a new revision and changes nothing else.
#
# Secrets are read from stdin into Secret Manager and never written to disk,
# never passed as an argument (argv is visible to `ps`), and never echoed. They
# reach the service as mounted secret references, so `gcloud run services
# describe` shows a secret *name*, never a value.
#
# --------------------------------------------------------------------------
# Why --allow-unauthenticated is correct here
# --------------------------------------------------------------------------
# Cloud Run IAM authentication would require every caller to present a Google
# OIDC ID token. The caller is a Cloudflare Worker, which has no Google identity
# and no metadata server, so it could only mint one from a downloaded GCP service
# account key stored in Cloudflare. That trades a single-purpose bearer token for
# a long-lived Google credential that can be exchanged for access tokens — a
# strictly worse secret, in a second vendor's store, with a worse blast radius.
#
# So the ingress is public and the application is the auth boundary:
#   * FIRSTSEEN_ENV=production makes AGENT_API_BEARER_TOKEN mandatory. Settings
#     refuses to construct without it, so the container cannot start unauthenticated.
#   * ALLOW_UNAUTHENTICATED_AGENT_DEV=false, and production refuses it anyway.
#   * Every /v1/* route checks the token with hmac.compare_digest before reading
#     a body, constructing an agent, or opening a database connection.
#   * /health is the only unauthenticated route. It takes no input, reads no
#     configuration, and touches no database.
#   * A per-token rate limit plus --max-instances caps the cost of a leaked token.
# See docs/deployment.md for the rotation procedure.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-firstseen-agent}"
REPO="${REPO:-firstseen}"
SA_NAME="${SA_NAME:-firstseen-agent}"
BUILD_SA_NAME="${BUILD_SA_NAME:-firstseen-build}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v gcloud >/dev/null || die "gcloud not found. https://cloud.google.com/sdk/docs/install"
[ -n "$PROJECT_ID" ] || PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ] \
  || die "set PROJECT_ID=<your-gcp-project> (or run 'gcloud config set project <id>')"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA_EMAIL="${BUILD_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SOURCE_BUCKET="gs://${PROJECT_ID}_cloudbuild"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:${IMAGE_TAG}"

echo "project   $PROJECT_ID"
echo "region    $REGION"
echo "service   $SERVICE"
echo "image     $IMAGE"

# --------------------------------------------------------------------- APIs
step "Enabling APIs"
# Enabling an already-enabled API is a no-op, so this is safe to repeat.
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  --project "$PROJECT_ID"

# ------------------------------------------------------- Artifact Registry
step "Artifact Registry repository"
if gcloud artifacts repositories describe "$REPO" \
     --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "repository $REPO already exists"
else
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location "$REGION" \
    --description="1stSeen container images" \
    --project "$PROJECT_ID"
fi

# ---------------------------------------------------------------- Secrets
create_secret_from_stdin() {
  local name="$1" prompt="$2" validate="$3"
  # A secret that exists without an enabled version would make `--set-secrets ...:latest`
  # fail at deploy, so only a secret with a usable version is left alone.
  if gcloud secrets versions list "$name" --project "$PROJECT_ID" --filter="state=ENABLED" \
       --limit=1 --format='value(name)' 2>/dev/null | grep -q .; then
    echo "secret $name already has an enabled version — leaving it in place."
    echo "  to rotate: see docs/deployment.md"
    return 0
  fi
  echo
  echo "$prompt"
  echo "Paste the value and press Enter. Input is not echoed."
  # -s keeps it off the terminal; the value goes straight from this shell's
  # stdin to the API. It is never written to a file and never appears in argv.
  # The value is read and checked before anything is created, so a mistyped or
  # empty paste stores nothing and a re-run starts clean.
  local value=""
  IFS= read -r -s value || true
  echo
  if ! printf '%s' "$value" | "$validate"; then
    unset value
    die "$name was empty or malformed; nothing was stored. Run the script again."
  fi
  if ! gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT_ID"
  fi
  printf '%s' "$value" \
    | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT_ID" >/dev/null
  unset value
  echo "stored $name"
}

# Validators read the candidate value on stdin, never from argv.
is_service_role_key() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
      if (raw.startsWith("sb_secret_") && raw.length > 20) process.exit(0);
      const parts = raw.split(".");
      if (parts.length !== 3) process.exit(1);
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        process.exit(payload.role === "service_role" ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}
is_bearer_token() {
  local token
  IFS= read -r token || true
  [[ "$token" =~ ^[A-Za-z0-9_-]{32,}$ ]]
}

step "Secret Manager"
create_secret_from_stdin SUPABASE_SERVICE_ROLE_KEY \
  "SUPABASE_SERVICE_ROLE_KEY — Supabase dashboard, Project Settings -> API -> service_role." \
  is_service_role_key
create_secret_from_stdin AGENT_API_BEARER_TOKEN \
  "AGENT_API_BEARER_TOKEN — generate with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='" \
  is_bearer_token

# -------------------------------------------------------- Service account
step "Service account"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account $SA_EMAIL already exists"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="1stSeen agent API runtime" \
    --description="Cloud Run runtime identity. Reads two secrets; nothing else." \
    --project "$PROJECT_ID"
fi

# Granted per secret, not project-wide: roles/secretmanager.secretAccessor at the
# project level would read every secret in the project. This identity gets no
# other role — no logging, no storage, no Cloud Run admin. Supabase access comes
# from the service-role key it reads, not from Google IAM.
for secret in SUPABASE_SERVICE_ROLE_KEY AGENT_API_BEARER_TOKEN; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project "$PROJECT_ID" >/dev/null
  echo "granted secretAccessor on $secret"
done

# ----------------------------------------------------- Build service account
step "Build service account"
# Newer projects run Cloud Build as the Compute Engine default service account and grant it nothing, so a build fails
# reading its own uploaded source. Rather than give that shared account the broad Cloud Build role, the build runs as
# its own identity with exactly three grants: read its source bucket, write this one image repository, write logs.
if gcloud iam service-accounts describe "$BUILD_SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account $BUILD_SA_EMAIL already exists"
else
  gcloud iam service-accounts create "$BUILD_SA_NAME" \
    --display-name="1stSeen agent image build" \
    --description="Cloud Build identity for the agent image. Reads its source, writes one repository, writes logs." \
    --project "$PROJECT_ID"
fi
# gcloud builds submit uploads the source to this bucket; create it first so the grant has something to name.
gcloud storage buckets describe "$SOURCE_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud storage buckets create "$SOURCE_BUCKET" --project "$PROJECT_ID" --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "$SOURCE_BUCKET" \
  --member="serviceAccount:${BUILD_SA_EMAIL}" --role="roles/storage.objectViewer" --project "$PROJECT_ID" >/dev/null
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
  --member="serviceAccount:${BUILD_SA_EMAIL}" --role="roles/artifactregistry.writer" --project "$PROJECT_ID" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA_EMAIL}" --role="roles/logging.logWriter" --condition=None >/dev/null
echo "granted source read, repository write, and log write to $BUILD_SA_EMAIL"

# ------------------------------------------------------------------ Build
step "Build and push"
# Context is the repository root because the Dockerfile copies worker/; the
# .dockerignore in worker/ keeps everything else out of the upload. --tag would
# need a Dockerfile at the root, so worker/cloudbuild.yaml names worker/Dockerfile.
gcloud builds submit \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --config worker/cloudbuild.yaml \
  --service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA_EMAIL}" \
  --gcs-source-staging-dir "${SOURCE_BUCKET}/source" \
  --substitutions "_IMAGE=$IMAGE" \
  --ignore-file worker/.dockerignore \
  .

# ----------------------------------------------------------------- Deploy
step "Deploy"
[ -n "${SUPABASE_URL:-}" ] || die "set SUPABASE_URL=https://<ref>.supabase.co (it is not a secret, but it is required)"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SA_EMAIL" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,AGENT_API_BEARER_TOKEN=AGENT_API_BEARER_TOKEN:latest" \
  --set-env-vars "SUPABASE_URL=${SUPABASE_URL},FIRSTSEEN_ENV=production,ALLOW_UNAUTHENTICATED_AGENT_DEV=false,AGENT_INTENT_LLM_ENABLED=false" \
  --min-instances=0 \
  --max-instances=1 \
  --max=1 \
  --concurrency=40 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=300 \
  --allow-unauthenticated \
  --port=8080 \
  --execution-environment=gen2 \
  --startup-probe="httpGet.path=/health,initialDelaySeconds=5,periodSeconds=5,timeoutSeconds=3,failureThreshold=10"

URL="$(gcloud run services describe "$SERVICE" \
        --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

step "Deployed"
echo "service URL: $URL"
echo
echo "Verify:"
echo "  curl -s $URL/health"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' -X POST $URL/v1/forecast-replay   # expect 401"
echo
echo "Point the web app at it:"
echo "  FIRSTSEEN_AGENT_API_URL=$URL"
echo "  AGENT_API_BEARER_TOKEN=<the same value stored in Secret Manager>"
echo
echo "Confirm no secret value is in the service definition:"
echo "  gcloud run services describe $SERVICE --region $REGION --format=export | grep -A3 -i secret"
