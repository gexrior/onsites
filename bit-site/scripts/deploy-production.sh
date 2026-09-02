#!/usr/bin/env bash
set -Eeuo pipefail

SITE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REPO_ROOT=$(git -C "$SITE_DIR" rev-parse --show-toplevel)
PRODUCTION_CONFIG="$SITE_DIR/wrangler.production.jsonc"
PRODUCTION_URL="https://bit.onsites.me"
WRANGLER_VERSION="4.114.0"
WRANGLER=(npx --offline --yes "wrangler@$WRANGLER_VERSION")
LOCK_DIR="${TMPDIR:-/tmp}/bit-onsites-production-deploy.lock"
ALLOW_ARGS=()
REASON="protected production deploy"

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-production.sh [options]

Options:
  --allow-route=/LINKI
  --allow-route=/VPNAH
  --allow-route=/VPNAH/tutorial
  --reason="why this production deployment is needed"

Protected-route approvals are independent. There is intentionally no --force or --allow-all option.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --allow-route=/LINKI|--allow-route=/VPNAH|--allow-route=/VPNAH/tutorial)
      ALLOW_ARGS+=("$argument")
      ;;
    --reason=*)
      REASON=${argument#--reason=}
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((${#ALLOW_ARGS[@]} > 0)) && [[ "$REASON" == "protected production deploy" ]]; then
  echo "A specific --reason is required when changing a protected route." >&2
  exit 2
fi

CANONICAL_DIR=${BIT_ONSITES_CANONICAL_DIR:-$(git -C "$REPO_ROOT" config --local --get bit.onsites.canonicalPath || true)}
if [[ -z "$CANONICAL_DIR" || "$(cd "$CANONICAL_DIR" 2>/dev/null && pwd -P)" != "$SITE_DIR" ]]; then
  echo "Production deploy blocked: this is not the registered canonical bit-site directory." >&2
  exit 1
fi

if [[ "$(git -C "$REPO_ROOT" branch --show-current)" != "main" ]]; then
  echo "Production deploy blocked: only main may deploy." >&2
  exit 1
fi

git -C "$REPO_ROOT" fetch --quiet origin main
if [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$(git -C "$REPO_ROOT" rev-parse origin/main)" ]]; then
  echo "Production deploy blocked: local HEAD is not the latest origin/main." >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- bit-site)" ]]; then
  echo "Production deploy blocked: bit-site contains uncommitted or untracked files." >&2
  git -C "$REPO_ROOT" status --short -- bit-site >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Production deploy blocked: another bit-onsites deployment is already running." >&2
  exit 1
fi

UPLOAD_LOG=$(mktemp)
cleanup() {
  rm -f "$UPLOAD_LOG"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

current_version() {
  "${WRANGLER[@]}" deployments list --json --config "$PRODUCTION_CONFIG" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const d=a.at(-1);const v=d?.versions?.find(x=>x.percentage===100)||d?.versions?.[0];if(!v?.version_id)process.exit(1);process.stdout.write(v.version_id);});'
}

cd "$SITE_DIR"

"${WRANGLER[@]}" whoami >/dev/null
node scripts/check-protected-pages.mjs local

ACTIVE_BEFORE=$(current_version)
if ((${#ALLOW_ARGS[@]} > 0)); then
  node scripts/check-protected-pages.mjs preflight --base-url="$PRODUCTION_URL" "${ALLOW_ARGS[@]}"
else
  node scripts/check-protected-pages.mjs preflight --base-url="$PRODUCTION_URL"
fi
if [[ "$(current_version)" != "$ACTIVE_BEFORE" ]]; then
  echo "Production deploy blocked: active Worker changed during preflight." >&2
  exit 1
fi

"${WRANGLER[@]}" versions upload --dry-run --strict --config "$PRODUCTION_CONFIG" >/dev/null

SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
SHORT_SHA=${SHA:0:12}
STAMP=$(date +%s)
TAG="guard-${SHORT_SHA}-${STAMP}"
MESSAGE="git:${SHORT_SHA} ${REASON}"
if ((${#MESSAGE} > 120)); then
  echo "Deployment reason is too long; keep the final message within 120 characters." >&2
  exit 2
fi

"${WRANGLER[@]}" versions upload \
  --strict \
  --config "$PRODUCTION_CONFIG" \
  --tag "$TAG" \
  --preview-alias "$TAG" \
  --message "$MESSAGE" | tee "$UPLOAD_LOG"

VERSIONS_JSON=$("${WRANGLER[@]}" versions list --json --config "$PRODUCTION_CONFIG")
VERSION_ID=$(MESSAGE="$MESSAGE" node -e 'const a=JSON.parse(process.argv[1]);const m=process.env.MESSAGE;const v=[...a].reverse().find(x=>x.annotations?.["workers/message"]===m);if(!v?.id)process.exit(1);process.stdout.write(v.id);' "$VERSIONS_JSON")

PREVIEW_URL=$(perl -pe 's/\e\[[0-9;]*[[:alpha:]]//g' "$UPLOAD_LOG" |
  grep -Eo 'https://[^[:space:]]+\.workers\.dev' | tail -1 || true)
if [[ -z "$VERSION_ID" || -z "$PREVIEW_URL" ]]; then
  echo "Production deploy blocked: could not identify the uploaded Version Preview." >&2
  exit 1
fi

node scripts/check-protected-pages.mjs verify --base-url="$PREVIEW_URL"
if [[ "$(current_version)" != "$ACTIVE_BEFORE" ]]; then
  echo "Production deploy blocked: active Worker changed while the candidate was tested." >&2
  exit 1
fi

"${WRANGLER[@]}" versions deploy "${VERSION_ID}@100%" \
  --yes \
  --config "$PRODUCTION_CONFIG" \
  --message "$MESSAGE"

if ! node scripts/check-protected-pages.mjs verify --base-url="$PRODUCTION_URL"; then
  ACTIVE_AFTER=$(current_version || true)
  if [[ "$ACTIVE_AFTER" == "$VERSION_ID" ]]; then
    echo "Post-deploy verification failed; restoring exact previous version $ACTIVE_BEFORE." >&2
    "${WRANGLER[@]}" versions deploy "${ACTIVE_BEFORE}@100%" \
      --yes \
      --config "$PRODUCTION_CONFIG" \
      --message "automatic restore after failed git:${SHORT_SHA} verification"
  fi
  exit 1
fi

echo "Production verified: $PRODUCTION_URL is running Worker version $VERSION_ID (git $SHA)."
