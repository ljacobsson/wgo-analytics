#!/usr/bin/env bash
# Deploy WGO: backend stack, then dashboard + SDK to the stack's S3/CloudFront.
#
# Configuration comes from environment variables, optionally loaded from ./deploy.env
# (see deploy.env.example). Everything except AWS credentials/region is optional:
#
#   STACK_NAME             CloudFormation stack name (default: wgo)
#   AWS_REGION             region for the stack (default: your AWS CLI default)
#   CUSTOM_DOMAIN          e.g. wgo.example.com: dashboard, SDK and ingest on your own domain
#   HOSTED_ZONE_ID         Route 53 zone of CUSTOM_DOMAIN (auto-detected); enables automatic certificate + DNS
#   CERTIFICATE_ARN        bring your own ACM certificate (us-east-1) when the DNS is not in Route 53
#   ALLOWED_EMAIL_DOMAINS  comma-separated, e.g. "example.com,*.example.org": only these can sign up / sign in
#   ALLOW_SELF_SIGNUP      true (default) | false
#   UPDATE_CHECK           true (default) | false: the dashboard tells you when GitHub has a newer version
#   DELETION_PROTECTION    false (default) | true  (DSQL cluster)
#   MCP_ENABLED            true (default) | false: the MCP server at /mcp and Cognito MCP auth (open client registration)
#   MAX_RETENTION_DAYS     400 (default): the longest raw-data retention project owners can pick (default retention: 90 days)
#   WRITE_BUFFER_SECONDS   30 (default): how long incoming data is collected before it is written as one Parquet file
#   CLUSTER_METRICS_PROJECT_ID  optional project id that receives hourly Aurora DSQL storage/DPU metrics and a wgo.cluster event
#   SLACK_CLIENT_ID        optional: one Slack app for "Add to Slack" in every project (otherwise each project
#   SLACK_CLIENT_SECRET    sets it up from its Triggers page in about a minute)
#   PARAMS                 extra raw `sam deploy --parameter-overrides`
#   BUILD_ANDROID          true = rebuild the Android widget APK (default: deploy the one committed in the repo)
#
#   ./scripts/deploy.sh                    full deploy
#   ./scripts/deploy.sh --frontend-only    only rebuild + upload dashboard and SDK (no SAM, ~30 s)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${DEPLOY_ENV:-$ROOT/deploy.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

FRONTEND_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --frontend-only) FRONTEND_ONLY=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

STACK_NAME="${STACK_NAME:-wgo}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || true)}"
: "${AWS_REGION:?Set AWS_REGION}"
export AWS_REGION
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"
ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-}"

step() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# The longest public Route 53 zone that is a suffix of the domain, e.g. example.com for wgo.example.com.
find_zone() {
  local domain="$1." best="" best_len=0
  while read -r name id private; do
    [ "$private" = "False" ] || continue
    case "$domain" in
      *."$name" | "$name")
        if [ "${#name}" -gt "$best_len" ]; then best="${id##*/}"; best_len="${#name}"; fi ;;
    esac
  done < <(aws route53 list-hosted-zones --query 'HostedZones[].[Name,Id,Config.PrivateZone]' --output text 2>/dev/null || true)
  echo "$best"
}

if [ "$FRONTEND_ONLY" = false ]; then
  if [ -n "$CUSTOM_DOMAIN" ]; then
    [ -n "$HOSTED_ZONE_ID" ] || HOSTED_ZONE_ID="$(find_zone "$CUSTOM_DOMAIN")"
    if [ -z "$CERTIFICATE_ARN" ]; then
      [ -n "$HOSTED_ZONE_ID" ] || die "No Route 53 zone found for $CUSTOM_DOMAIN. Create an ACM certificate for it in us-east-1 and set CERTIFICATE_ARN; after deploying, point a CNAME at the CloudFrontDomain output."
      step "Certificate for $CUSTOM_DOMAIN (us-east-1, DNS-validated in zone $HOSTED_ZONE_ID; first run takes a few minutes)"
      aws cloudformation deploy \
        --region us-east-1 \
        --stack-name "$STACK_NAME-certificate" \
        --template-file "$ROOT/backend/certificate.yaml" \
        --parameter-overrides "DomainName=$CUSTOM_DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" \
        --no-fail-on-empty-changeset
      CERTIFICATE_ARN="$(aws cloudformation describe-stacks --region us-east-1 --stack-name "$STACK_NAME-certificate" \
        --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue" --output text)"
    fi
  fi

  step "Backend: install, test, build"
  cd "$ROOT/backend"
  npm ci --no-audit --no-fund
  npm run typecheck
  npx vitest run --exclude 'test/integration.*'
  # SAM's esbuild builder looks for esbuild on PATH; use the project's own (a devDependency)
  PATH="$ROOT/backend/node_modules/.bin:$PATH" sam build

  overrides=()
  [ -n "$CUSTOM_DOMAIN" ] && overrides+=("CustomDomain=$CUSTOM_DOMAIN" "CertificateArn=$CERTIFICATE_ARN")
  [ -n "$CUSTOM_DOMAIN" ] && [ -n "$HOSTED_ZONE_ID" ] && overrides+=("HostedZoneId=$HOSTED_ZONE_ID")
  [ -n "$ALLOWED_EMAIL_DOMAINS" ] && overrides+=("AllowedEmailDomains=${ALLOWED_EMAIL_DOMAINS// /}")
  [ -n "${ALLOW_SELF_SIGNUP:-}" ] && overrides+=("AllowSelfSignup=$ALLOW_SELF_SIGNUP")
  [ -n "${DELETION_PROTECTION:-}" ] && overrides+=("DeletionProtection=$DELETION_PROTECTION")
  [ -n "${MCP_ENABLED:-}" ] && overrides+=("EnableMcp=$MCP_ENABLED")
  [ -n "${MAX_RETENTION_DAYS:-}" ] && overrides+=("MaxRetentionDays=$MAX_RETENTION_DAYS")
  [ -n "${WRITE_BUFFER_SECONDS:-}" ] && overrides+=("WriteBufferSeconds=$WRITE_BUFFER_SECONDS")
  [ -n "${CLUSTER_METRICS_PROJECT_ID:-}" ] && overrides+=("ClusterMetricsProjectId=$CLUSTER_METRICS_PROJECT_ID")
  [ -n "${SLACK_CLIENT_ID:-}" ] && overrides+=("SlackClientId=$SLACK_CLIENT_ID" "SlackClientSecret=${SLACK_CLIENT_SECRET:-}")
  # shellcheck disable=SC2206
  [ -n "${PARAMS:-}" ] && overrides+=($PARAMS)

  step "Backend: deploy stack $STACK_NAME ($AWS_REGION)${CUSTOM_DOMAIN:+ on $CUSTOM_DOMAIN}"
  sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --capabilities CAPABILITY_IAM \
    --resolve-s3 \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    ${overrides[@]+--parameter-overrides "${overrides[@]}"}
else
  step "Frontend only: using outputs of existing stack $STACK_NAME ($AWS_REGION)"
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" >/dev/null \
    || die "Stack $STACK_NAME not found — run a full deploy first."
fi

out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
API_URL="$(out ApiUrl)"
INGEST_URL="$(out IngestUrl)"
# stacks deployed before the CloudFront ingest route have no IngestUrl output
if [ -z "$INGEST_URL" ] || [ "$INGEST_URL" = "None" ]; then INGEST_URL="$API_URL"; fi
WS_URL="$(out WsUrl)"
SDK_URL="$(out SdkUrl)"
DASHBOARD_URL="$(out DashboardUrl)"
CLOUDFRONT_DOMAIN="$(out CloudFrontDomain)"
BUCKET="$(out WebBucketName)"
DISTRIBUTION="$(out DistributionId)"
USER_POOL_ID="$(out UserPoolId)"
USER_POOL_CLIENT_ID="$(out UserPoolClientId)"
MCP_URL="$(out McpUrl)"
MCP_STATE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='EnableMcp'].ParameterValue" --output text 2>/dev/null || true)"
# the allowlist the stack actually runs with (also right for --frontend-only)
DEPLOYED_ALLOWLIST="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='AllowedEmailDomains'].ParameterValue" --output text 2>/dev/null || true)"
[ "$DEPLOYED_ALLOWLIST" = "None" ] && DEPLOYED_ALLOWLIST=""
ALLOWLIST_JSON="$(printf '%s' "$DEPLOYED_ALLOWLIST" | tr ',' '\n' | sed '/^$/d; s/.*/"&"/' | paste -sd, -)"
# the sign-in page offers "Create account" only when self sign-up is on (the template default)
SELF_SIGNUP="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='AllowSelfSignup'].ParameterValue" --output text 2>/dev/null || true)"
[ "$SELF_SIGNUP" = "false" ] || SELF_SIGNUP=true
# what is being deployed, so the dashboard can tell when main on GitHub has moved on (UPDATE_CHECK=false turns that off)
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEPLOY_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
DEPLOY_COMMIT_DATE="$(git -C "$ROOT" log -1 --format=%cI 2>/dev/null || true)"
if [ "${UPDATE_CHECK:-true}" = false ]; then UPDATE_CHECK=false; else UPDATE_CHECK=true; fi

step "SDK: build"
cd "$ROOT/sdk"
npm ci --no-audit --no-fund
npm run build

# The APK in dashboard/public/downloads is committed: it pairs with any deployment, so rebuilding is opt-in
# (needs JDK 17 + the Android SDK, and see scripts/build-android.sh about the signing key).
if [ "${BUILD_ANDROID:-false}" = true ]; then
  step "Android widget app: build"
  "$ROOT/scripts/build-android.sh" || die "Android build failed (exit code 3 = no JDK 17 / Android SDK found)"
fi

step "Dashboard: build"
cd "$ROOT/dashboard"
npm ci --no-audit --no-fund
npm run build
# the dashboard's MCP page shows setup instructions only when the server is on
MCP_CONFIG_URL=""
if [ -n "$MCP_URL" ] && [ "$MCP_URL" != "None" ] && [ "$MCP_STATE" != "false" ]; then MCP_CONFIG_URL="$MCP_URL"; fi
cat > dist/config.json <<JSON
{
  "apiUrl": "$API_URL",
  "ingestUrl": "$INGEST_URL",
  "wsUrl": "$WS_URL",
  "sdkUrl": "$SDK_URL",
  "region": "$AWS_REGION",
  "userPoolId": "$USER_POOL_ID",
  "userPoolClientId": "$USER_POOL_CLIENT_ID",
  "allowedEmailDomains": [$ALLOWLIST_JSON],
  "selfSignup": $SELF_SIGNUP,
  "deployedAt": "$DEPLOYED_AT",
  "commit": "$DEPLOY_COMMIT",
  "commitDate": "$DEPLOY_COMMIT_DATE",
  "updateCheck": $UPDATE_CHECK,
  "mcpUrl": "$MCP_CONFIG_URL"
}
JSON
# check before uploading anything, so a broken checkout can't leave a half-uploaded site
for f in wgo-kiosk.sh wgo-android.apk android.json; do
  [ -f "dist/downloads/$f" ] || die "dashboard/public/downloads/$f is missing from the build"
done

step "Upload to s3://$BUCKET"
# hashed assets are immutable; the shell, config and SDK must revalidate
aws s3 sync dist "s3://$BUCKET" --delete --exclude 'sdk/*' \
  --exclude index.html --exclude config.json --exclude pair.html --exclude 'downloads/*' \
  --cache-control 'public, max-age=31536000, immutable'
aws s3 cp dist/pair.html "s3://$BUCKET/pair.html" --cache-control 'no-cache' --content-type 'text/html'
# Raspberry Pi kiosk setup (curl … | sudo bash): served as text so browsers show it instead of downloading it
aws s3 cp dist/downloads/wgo-kiosk.sh "s3://$BUCKET/downloads/wgo-kiosk.sh" --cache-control 'no-cache' --content-type 'text/plain; charset=utf-8'
# the APK keeps a fixed name so links and QR codes stay valid; android.json describes the current build
aws s3 cp dist/downloads/wgo-android.apk "s3://$BUCKET/downloads/wgo-android.apk" \
  --cache-control 'no-cache' --content-type 'application/vnd.android.package-archive' \
  --content-disposition 'attachment; filename="wgo-android.apk"'
aws s3 cp dist/downloads/android.json "s3://$BUCKET/downloads/android.json" --cache-control 'no-cache' --content-type 'application/json'
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control 'no-cache' --content-type 'text/html'
aws s3 cp dist/config.json "s3://$BUCKET/config.json" --cache-control 'no-cache' --content-type 'application/json'
aws s3 cp "$ROOT/sdk/dist/wgo.js" "s3://$BUCKET/sdk/v1/wgo.js" \
  --cache-control 'public, max-age=300' --content-type 'text/javascript'

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths /index.html /config.json /pair.html '/sdk/*' '/downloads/*' >/dev/null

cat <<EOF

$(printf '\033[1;32m✔ WGO deployed\033[0m')
  Dashboard  $DASHBOARD_URL
  Sign up    $DASHBOARD_URL/#/signup      (create your account here)
  API        $API_URL
  Live       $WS_URL
  SDK        $SDK_URL
  Ingest     $INGEST_URL      (SDK data-endpoint)
  OTLP       $INGEST_URL/v1/{traces,logs,metrics}   (header x-wgo-key)
EOF
if [ -n "$MCP_URL" ] && [ "$MCP_URL" != "None" ] && [ "$MCP_STATE" != "false" ]; then
  echo "  MCP        $MCP_URL      (claude mcp add --transport http wgo $MCP_URL)"
fi
if [ -n "$CUSTOM_DOMAIN" ] && [ -z "$HOSTED_ZONE_ID" ] && [ "$FRONTEND_ONLY" = false ]; then
  echo "  DNS        point a CNAME for $CUSTOM_DOMAIN at $CLOUDFRONT_DOMAIN"
fi
[ -n "$DEPLOYED_ALLOWLIST" ] && echo "  Sign-ups   only: $DEPLOYED_ALLOWLIST"
if [ -n "${SLACK_CLIENT_ID:-}" ]; then
  echo "  Slack      \"Add to Slack\" is on for every project (instance-wide Slack app)"
else
  echo "  Slack      set up \"Add to Slack\" from a project's Triggers page (one-time, about a minute)"
fi
exit 0
