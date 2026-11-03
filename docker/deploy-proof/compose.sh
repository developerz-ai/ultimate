#!/usr/bin/env bash
# The Compose deploy a stranger runs, performed: `x new` on this tree's packages, then the three
# commands the docs give — `x env init --production`, `x build --target docker`, `x deploy` — and
# `/readyz` and `/` answering 200 on the published port. The only proof a fresh scaffold's
# Compose deploy boots; `container` builds and renders, and `deploy-proof` takes the chart.
#
#   bash docker/deploy-proof/compose.sh      # KEEP_STACK=1 leaves it running to inspect
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
APP="$WORK/proofapp"
PORT=3000

refuse() { echo "::error title=compose proof::$1"; exit 1; }
step() { echo "── $1"; }
# shellcheck source=docker/deploy-proof/scaffold.sh
. "$REPO/docker/deploy-proof/scaffold.sh"

for tool in docker bun jq curl timeout; do
  command -v "$tool" >/dev/null || refuse "$tool is not on PATH. fix: install $tool, then re-run bash docker/deploy-proof/compose.sh"
done

cleanup() {
  if [ "${KEEP_STACK:-0}" != 1 ] && [ -f "$APP/docker/docker-compose.prod.yml" ]; then
    (cd "$APP" && docker compose --env-file .env.production -f docker/docker-compose.prod.yml down -v --remove-orphans >/dev/null 2>&1) || true
  fi
}
trap cleanup EXIT

step "x new proofapp, on this tree's packages"
scaffold_proof_app "$REPO" "$WORK"

step "x env init --production"
(cd "$APP" && bunx x env init --production --json >"$WORK/env-init.json") \
  || refuse "x env init --production failed: $(jq -c '.findings // .' "$WORK/env-init.json"). fix: cd $APP && bunx x env init --production --json"
git -C "$APP" check-ignore -q .env.production \
  || refuse ".env.production is not gitignored after x env init, so a git add -A commits the secrets. fix: see ignoreEnvFile in packages/cli/src/cmd-env-init.ts"

# `--no-preflight`: the static gate over a fresh scaffold is scaffold-smoke's question, asked there
# twice per shape. This leg asks whether the image the build makes deploys.
step "x build --target docker"
(cd "$APP" && bunx x build --target docker --no-preflight --json >"$WORK/build.json") \
  || refuse "x build --target docker failed: $(jq -c '.findings // .' "$WORK/build.json"). fix: cd $APP && bunx x build --target docker --no-preflight --json"

step "x deploy"
(cd "$APP" && timeout 600 bunx x deploy --json >"$WORK/deploy.json") \
  || refuse "x deploy failed: $(jq -c '.findings // .' "$WORK/deploy.json"). fix: KEEP_STACK=1 bash docker/deploy-proof/compose.sh, then cd $APP && docker compose --env-file .env.production -f docker/docker-compose.prod.yml logs"

step "/readyz and / answer 200 on :$PORT"
for path in /readyz /; do
  code=000
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path" || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || refuse "GET $path answered $code after x deploy reported ok. fix: KEEP_STACK=1 bash docker/deploy-proof/compose.sh, then cd $APP && docker compose --env-file .env.production -f docker/docker-compose.prod.yml logs web"
done
echo "ok: a fresh scaffold deployed with x env init --production, x build --target docker and x deploy; /readyz and / answer 200"
