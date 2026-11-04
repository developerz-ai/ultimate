#!/usr/bin/env bash
# Sourced, never run: what run.sh adds to the scaffold so the roll has a job and a migration to
# cross. `add_held_job` (v1) writes one untenanted table, a job that records a row per attempt and
# holds for `holdSeconds`, a public action that enqueues it and a public GET over the rows.
# `add_v2_column` (v2 only) adds one nullable column the v2 job writes, so v1 and v2 differ by a migration.
#
#   add_held_job "$APP"; add_v2_column "$APP"     # then `x db gen` in "$APP"

# The v2 migration's name, which held-assert.sh looks up in x_migrations after the roll.
# shellcheck disable=SC2034
V2_MIGRATION=deploy_proof_v2

add_held_job() {
  local app="$1" dir="$1/apps/web/app/proof"
  mkdir -p "$dir"
  cat >"$dir/entity.ts" <<'TS'
// One row per attempt of the deploy proof's job: which build ran it, on which pod, and how it ended.
import { entity, integer, text, timestamp, uuid } from '@ultimat3/entity';

export const proofAttempt = entity('proof_attempts', {
  columns: {
    id: uuid().primaryKey(),
    jobKey: text({ max: 100 }),
    attempt: integer(),
    build: text({ max: 100 }),
    host: text({ max: 200 }),
    state: text({ max: 20 }),
    startedAt: timestamp().defaultNow(),
  },
});

export type ProofAttempt = typeof proofAttempt.$row;
TS
  cat >"$dir/repo.ts" <<'TS'
// The proof's rows: written by the job body, read by the GET the load sends.
import { db } from '@proofapp/db';
import type { ProofAttempt } from './entity';

export async function started(jobKey: string, attempt: number): Promise<ProofAttempt> {
  return db.proofAttempts.insert({
    jobKey,
    attempt,
    build: Bun.env['BUILD_ID'] ?? 'none',
    host: Bun.env['HOSTNAME'] ?? 'none',
    state: 'running',
  });
}

export async function finished(id: string): Promise<void> {
  await db.proofAttempts.update(id, { state: 'done' });
}

export async function byKey(jobKey: string): Promise<readonly ProofAttempt[]> {
  return db.proofAttempts.where({ jobKey }).orderBy('startedAt', 'desc').limit(5).all();
}
TS
  cat >"$dir/hold-job.ts" <<'TS'
// The job a deploy must not cut: a row per attempt, then a hold longer than the drain budget.
import { job, t } from '@ultimat3/jobs';
import * as repo from './repo';

export const holdJob = job({
  input: t.object({ key: t.string, holdSeconds: t.number }),
  tenant: 'none',
  idempotencyKey: ({ key }) => `hold:${key}`,
  timeout: '5m',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, attempt }) {
    const row = await repo.started(input.key, attempt);
    await Bun.sleep(input.holdSeconds * 1000);
    await repo.finished(row.id);
    return { held: input.holdSeconds };
  },
});
TS
  cat >"$dir/enqueue-hold.ts" <<'TS'
// Public on purpose: the deploy proof's load pod and run.sh enqueue through the real HTTP path.
import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { holdJob } from './hold-job';

export const enqueueHold = action({
  input: t.object({ key: t.string, holdSeconds: t.number }),
  output: t.object({ id: t.string, deduped: t.boolean }),
  policy: allow('public'),
  async handle({ input }) {
    const queued = await holdJob.enqueue(input);
    return { id: queued.id, deduped: queued.deduped };
  },
});
TS
  cat >"$dir/proof-attempts.ts" <<'TS'
// The read half of the load: every column the build's entity declares, so v2 reads the new one.
import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import type { ProofAttempt } from './entity';
import * as repo from './repo';

export const proofAttempts = query({
  input: t.object({ key: t.string }),
  policy: allow('public'),
  sql: ({ key }) => from<ProofAttempt>('proof_attempts', () => repo.byKey(key)),
});
TS
  # shellcheck disable=SC2016  # the template literals are the script's own, never the shell's
  (cd "$app" && bun -e '
    const edit = async (path, pairs) => {
      let text = await Bun.file(path).text();
      for (const [anchor, added] of pairs) {
        if (!text.includes(anchor)) throw new TypeError(`${path} lost the line "${anchor}"`);
        text = text.replace(anchor, `${anchor}\n${added}`);
      }
      await Bun.write(path, text);
    };
    await edit("packages/db/src/client.ts", [
      ["import { post } from \x27@proofapp/web/app/post/entity\x27;",
       "import { proofAttempt } from \x27@proofapp/web/app/proof/entity\x27;"],
      ["  posts: post,", "  proofAttempts: proofAttempt,"],
    ]);
    await edit("apps/web/api/index.ts", [
      ["import * as health from \x27./health\x27;",
       "import * as enqueueHold from \x27../app/proof/enqueue-hold\x27;\nimport * as holdJob from \x27../app/proof/hold-job\x27;\nimport * as proofAttempts from \x27../app/proof/proof-attempts\x27;"],
    ]);
    let api = await Bun.file("apps/web/api/index.ts").text();
    api = api
      .replace("actions: [health,", "actions: [enqueueHold, health,")
      .replace("queries: [postList]", "queries: [postList, proofAttempts]")
      .replace("jobs: [reindexPost]", "jobs: [holdJob, reindexPost]");
    for (const name of ["enqueueHold, health", "postList, proofAttempts", "holdJob, reindexPost"]) {
      if (!api.includes(name)) throw new TypeError(`apps/web/api/index.ts: defineApi no longer reads "${name}"`);
    }
    await Bun.write("apps/web/api/index.ts", api);
  ') || refuse "the held job could not be added to the scaffold. fix: read add_held_job in docker/deploy-proof/held-job.sh against packages/cli/src/templates (x new's db client and api/index.ts)"
}

# The one schema change the roll crosses: nullable, so v1's inserts still succeed beside it, and
# written by v2's job, so a v2 attempt row proves the code that needs the column ran after it landed.
add_v2_column() {
  local dir="$1/apps/web/app/proof"
  # shellcheck disable=SC2016  # the template literals are the script's own, never the shell's
  (cd "$1" && bun -e '
    const edit = async (path, from, to) => {
      const text = await Bun.file(path).text();
      if (!text.includes(from)) throw new TypeError(`${path} lost "${from}"`);
      await Bun.write(path, text.replace(from, to));
    };
    await edit("apps/web/app/proof/entity.ts", "    startedAt: timestamp().defaultNow(),",
      "    startedAt: timestamp().defaultNow(),\n    note: text({ max: 100 }).nullable(),");
    await edit("apps/web/app/proof/repo.ts", "    state: \x27running\x27,",
      "    state: \x27running\x27,\n    note: \x27v2 wrote the migrated column\x27,");
  ') || refuse "the v2 column could not be added to $dir. fix: read add_v2_column in docker/deploy-proof/held-job.sh"
}
