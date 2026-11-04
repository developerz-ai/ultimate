#!/usr/bin/env bash
# Sourced, never run: run.sh's job half, read by `kubectl exec` from the cluster's Postgres and the
# held pod's log. A job held across the roll must run ONCE, on a v1 worker that retired rather
# than drained; a job after it must be claimed by v2, which writes the column v2's migration added.
# Needs from the caller: refuse, step, WORK, HOLD_SECONDS, V2_MIGRATION (held-job.sh).

QUEUE=proofapp-default
FIX="KEEP_CLUSTER=1 bash docker/deploy-proof/run.sh, then read"

# One value from the proof's database, unaligned, no header.
pg() { kubectl exec deploy/postgres -- psql -U postgres -d proofapp -tAc "$1"; }

# Through the real HTTP path, from inside a web pod: the enqueue action's own route.
enqueue_hold() {
  kubectl exec deploy/proofapp-web -- bun -e "
    const res = await fetch('http://127.0.0.1:3000/api/holds/enqueue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '$1', holdSeconds: $2 }),
    });
    console.log(await res.text());
  " | jq -r '.id // empty'
}

# Poll until `sql` answers `want`, or refuse naming what it last answered.
await_value() {
  local sql="$1" want="$2" seconds="$3" what="$4" got=''
  for _ in $(seq 1 "$seconds"); do
    got="$(pg "$sql" || true)"
    [ "$got" = "$want" ] && return 0
    sleep 1
  done
  refuse "$what: waited ${seconds}s for '$want', last read '$got'. fix: $FIX $5"
}

# Step 1: enqueue the held job, see it running on a v1 worker, and follow that pod's log while it
# still exists — the retire line is only readable before the pod goes.
hold_before_roll() {
  HELD_ID="$(enqueue_hold held "$HOLD_SECONDS")"
  [ -n "$HELD_ID" ] || refuse "POST /api/holds/enqueue returned no job id. fix: $FIX the web pod's log (kubectl logs deploy/proofapp-web) and add_held_job in docker/deploy-proof/held-job.sh"
  await_value "select state from proof_attempts where job_key = 'held'" running 60 \
    "the held job never started" "x_jobs (kubectl logs deploy/proofapp-worker) and packages/jobs/src/worker-loop.ts"
  local claimed_build
  HELD_WORKER="$(pg "select claimed_by from x_jobs where id = '$HELD_ID'")"
  claimed_build="$(pg "select w.build from x_jobs j join x_job_workers w on w.id = j.claimed_by where j.id = '$HELD_ID'")"
  [ "$claimed_build" = v1 ] \
    || refuse "the held job was claimed by a worker of build '$claimed_build', not v1. fix: $FIX x_job_workers and packages/jobs/src/driver-pg-claim-sql.ts"
  HELD_POD="$(pg "select host from proof_attempts where job_key = 'held'")"
  kubectl logs -f "pod/$HELD_POD" >"$WORK/held-pod.log" 2>&1 &
  HELD_LOG_PID=$!
  # The worker's own registry row, from Postgres: draining (the retire's first announce) while its
  # in-flight ids hold THIS job. inFlight > 0 in a log line alone could be a load job's.
  (
    for _ in $(seq 1 600); do
      [ "$(pg "select count(*) from x_job_workers where id = '$HELD_WORKER' and draining_at is not null and in_flight ? '$HELD_ID'" 2>/dev/null)" = 1 ] \
        && { touch "$WORK/held-draining"; exit 0; }
      sleep 1
    done
  ) &
  HELD_DRAIN_PID=$!
  echo "   held job $HELD_ID running on $HELD_POD (v1), ${HOLD_SECONDS}s"
}

# Step 3: exactly one attempt, done, by v1 — and the drain budget could not have done that alone.
assert_held_job() {
  local release deadline rows
  release="$(helm list -o json | jq -r '.[0].name')"
  deadline="$(helm get values "$release" --all -o json | jq -r '.drain.deadlineSeconds')"
  [ "$deadline" -lt "$HOLD_SECONDS" ] \
    || refuse "drain.deadlineSeconds is $deadline, not under the held job's ${HOLD_SECONDS}s, so a pass could be the plain SIGTERM drain. fix: HOLD_SECONDS=$((deadline * 3)) bash docker/deploy-proof/run.sh"
  await_value "select state in ('done', 'failed', 'dead', 'cancelled') from x_jobs where id = '$HELD_ID'" t \
    $((HOLD_SECONDS + 180)) "the held job never settled" "x_jobs and the v1 worker's log ($WORK/held-pod.log)"
  rows="$(pg "select string_agg(attempt || ':' || build || ':' || state, ',' order by started_at) from proof_attempts where job_key = 'held'")"
  [ "$rows" = '1:v1:done' ] \
    || refuse "the held job's attempts were '$rows' (attempt:build:state), not one v1 attempt that finished: the roll cut it. fix: $FIX packages/cli/src/serve-retire.ts and the worker preStop in packages/cli/src/templates/scaffold-helm-templates.ts"
  [ "$(pg "select state || ':' || claims from x_jobs where id = '$HELD_ID'")" = 'done:1' ] \
    || refuse "x_jobs row $HELD_ID is '$(pg "select state || ':' || claims from x_jobs where id = '$HELD_ID'")' (state:claims), not done on its first claim. fix: $FIX packages/jobs/src/worker-hand-back.ts"
}

# Step 3, second half: after the roll, v2 claims, on a schema v2's migration changed.
assert_v2_after() {
  [ "$(pg "select count(*) from x_migrations where id like '%\_$V2_MIGRATION'")" = 1 ] \
    || refuse "x_migrations has no $V2_MIGRATION, so the roll crossed no migration. fix: $FIX the migrate Job (kubectl logs job/proofapp-migrate) and add_v2_column in docker/deploy-proof/held-job.sh"
  [ "$(pg "select count(*) from x_job_workers where build = 'v2' and expires_at > now() and queues ? '$QUEUE'")" -gt 0 ] \
    || refuse "x_job_workers lists no live v2 worker for $QUEUE. fix: $FIX kubectl logs deploy/proofapp-worker"
  local after
  after="$(enqueue_hold after 0)"
  [ -n "$after" ] || refuse "POST /api/holds/enqueue after the roll returned no job id. fix: $FIX kubectl logs deploy/proofapp-web"
  await_value "select build || ':' || state || ':' || (note is not null) from proof_attempts where job_key = 'after'" 'v2:done:true' 120 \
    "the job enqueued after the roll was not run by v2 writing the migrated column" "x_jobs and kubectl logs deploy/proofapp-worker"
}

# Step 4: the v1 pod's exit was the retire, begun while it still held the job.
assert_retired() {
  kubectl wait --for=delete "pod/$HELD_POD" --timeout=120s >/dev/null 2>&1 \
    || refuse "pod $HELD_POD outlived its held job by 120s. fix: $FIX kubectl describe pod/$HELD_POD"
  wait "$HELD_LOG_PID" || true
  kill "$HELD_DRAIN_PID" 2>/dev/null || true
  [ -f "$WORK/held-draining" ] \
    || refuse "worker $HELD_WORKER never listed job $HELD_ID in flight while draining: the roll reached it after the held job ended, so the retire carried nothing of this proof's. fix: HOLD_SECONDS=$((HOLD_SECONDS * 2)) bash docker/deploy-proof/run.sh"
  local held
  held="$(jq -Rr --arg id "$HELD_WORKER" 'fromjson? | select(.msg == "jobs.worker.retiring" and .workerId == $id) | .inFlight' "$WORK/held-pod.log" | head -1)"
  [ -n "$held" ] && [ "$held" -gt 0 ] \
    || refuse "worker $HELD_WORKER on pod $HELD_POD logged no jobs.worker.retiring while holding a job (inFlight '$held'): it drained by SIGTERM, not by the retire. fix: read $WORK/held-pod.log and the worker preStop in packages/cli/src/templates/scaffold-helm-templates.ts"
  grep -q '"jobs.worker.retired"' "$WORK/held-pod.log" \
    || refuse "pod $HELD_POD exited without logging jobs.worker.retired. fix: read $WORK/held-pod.log and packages/cli/src/serve-retire.ts"
}
