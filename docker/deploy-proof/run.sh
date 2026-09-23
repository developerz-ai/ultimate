#!/usr/bin/env bash
# Milestone 11's proof, as one command: a scaffolded app's image on the chart `x new` writes,
# installed and then upgraded by `x deploy --method helm`, while a load pod inside the cluster
# sends mixed GET and POST through the Service. Green means the upgrade dropped ZERO requests.
#
#   bash docker/deploy-proof/run.sh            # from the repo root; needs docker kind helm kubectl bun jq
#   KEEP_CLUSTER=1 bash docker/deploy-proof/run.sh   # leave the kind cluster up to poke at
#
# The app is built from THIS tree, not from npm: every packages/* is packed into the app's
# vendor/ and pinned by `overrides`, so the image carries the framework the commit under test
# ships — including the drain the proof exists to measure. .github/workflows/ci.yml's
# `deploy-proof` job runs exactly this file.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
KIT="$REPO/docker/deploy-proof"
WORK="${WORK:-$(mktemp -d)}"
CLUSTER="${CLUSTER:-ultimate-proof}"
APP="$WORK/proofapp"
LOAD_SECONDS="${LOAD_SECONDS:-120}"
export KUBECONFIG="$WORK/kubeconfig"

refuse() { echo "::error title=deploy proof::$1"; exit 1; }
step() { echo "── $1"; }

for tool in docker kind helm kubectl bun jq; do
  command -v "$tool" >/dev/null || refuse "$tool is not on PATH. fix: install $tool, then re-run bash docker/deploy-proof/run.sh"
done

cleanup() {
  if [ "${KEEP_CLUSTER:-0}" != 1 ]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

step "x new proofapp, on this tree's packages"
(cd "$REPO" && bun run x -- new proofapp --dir "$WORK" --json >/dev/null)
mkdir -p "$APP/vendor"
for dir in "$REPO"/packages/*/; do
  name="$(jq -r .name "$dir/package.json")"
  case "$name" in @ultimat3/*) (cd "$dir" && bun pm pack --destination "$APP/vendor" --quiet >/dev/null 2>&1) ;; esac
done
(cd "$APP" && bun -e '
  const pkg = await Bun.file("package.json").json();
  pkg.overrides = {};
  for (const file of new Bun.Glob("vendor/ultimat3-*.tgz").scanSync(".")) {
    const name = file.slice("vendor/ultimat3-".length).replace(/-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/, "");
    pkg.overrides[`@ultimat3/${name}`] = `file:./${file}`;
  }
  await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
' && bun install >/dev/null && bunx x db gen initial --json >/dev/null)

step "two images, differing only by BUILD_ID"
for build in v1 v2; do
  docker build -q -f "$APP/docker/Dockerfile" --build-arg BUILD_ID="$build" -t "proofapp:$build" "$APP" >/dev/null
done

step "kind cluster $CLUSTER, the images, a database and the release's secret"
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s >/dev/null
for build in v1 v2; do kind load docker-image "proofapp:$build" --name "$CLUSTER" >/dev/null; done
kubectl apply -f "$KIT/postgres.yaml" >/dev/null
kubectl create secret generic proofapp-secrets \
  --from-literal=DATABASE_URL=postgres://postgres:proof@postgres:5432/proofapp \
  --from-literal=STORAGE_SIGNING_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" \
  --from-literal=ULTIMATE_CURSOR_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" \
  --from-literal=ULTIMATE_STATE_DIR=/tmp/x \
  --from-literal=ULTIMATE_ENV=production \
  --from-literal=TRUSTED_PROXY_HOPS=1 \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl rollout status deploy/postgres --timeout=180s >/dev/null

deploy() {
  local out="$WORK/deploy-$1.json"
  (cd "$APP" && bunx x deploy --method helm --image "proofapp:$1" --timeout 5m --json) > "$out" || true
  local status
  status="$(jq -r '.data.rollout.status // "unknown"' "$out")"
  echo "   x deploy proofapp:$1 -> $(jq -c '.data.rollout' "$out")"
  [ "$status" = deployed ] || refuse "x deploy --method helm --image proofapp:$1 reported rollout status '$status'. fix: KEEP_CLUSTER=1 bash docker/deploy-proof/run.sh, then kubectl get pods,events"
}

step "first install: the migrate hook must not wait on an object the chart has not made yet"
deploy v1

step "helm upgrade v1 -> v2 under ${LOAD_SECONDS}s of mixed GET/POST"
kubectl delete pod proof-load --ignore-not-found >/dev/null
kubectl run proof-load --image=proofapp:v1 --image-pull-policy=Never --restart=Never \
  --env=TARGET=http://proofapp-web --env=LOAD_SECONDS="$LOAD_SECONDS" \
  --command -- bun -e "$(cat "$KIT/load.ts")" >/dev/null
kubectl wait --for=condition=Ready pod/proof-load --timeout=120s >/dev/null
sleep 10
deploy v2
[ "$(kubectl get pod proof-load -o jsonpath='{.status.phase}')" = Running ] \
  || refuse "the load ended before the rollout did, so part of the upgrade went unmeasured. fix: LOAD_SECONDS=$((LOAD_SECONDS * 2)) bash docker/deploy-proof/run.sh"
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/proof-load --timeout="$((LOAD_SECONDS + 120))s" >/dev/null
proof="$(kubectl logs proof-load | sed -n 's/^PROOF //p')"
echo "   $proof"

total="$(jq -r .total <<<"$proof")"
failed="$(jq -r .failed <<<"$proof")"
old="$(jq -r '.builds.v1 // 0' <<<"$proof")"
new="$(jq -r '.builds.v2 // 0' <<<"$proof")"
[ "$old" -gt 0 ] && [ "$new" -gt 0 ] \
  || refuse "the load saw builds v1=$old v2=$new, so it did not span the rollout. fix: LOAD_SECONDS=$((LOAD_SECONDS * 2)) bash docker/deploy-proof/run.sh"
[ "$failed" = 0 ] \
  || refuse "$failed of $total requests failed during helm upgrade: $(jq -c .reasons <<<"$proof"). fix: read the sample bodies above, then the drain in packages/http/src/stages.ts and packages/core/src/lifecycle.ts"
echo "ok: $total requests across a rolling upgrade, 0 failed (v1=$old, v2=$new)"
