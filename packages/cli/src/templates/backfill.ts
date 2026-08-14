// `x g backfill` — a one-pass table sweep. The backfill is a factory over job(), not a ninth
// primitive, so it inherits .enqueue(), the retry policy, the cancellation and the manifest row.
// One live run per name: a second enqueue while the pass is going is the same pass.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

/**
 * Working source, never a stub: a generated `throw new Error(…)` carries no `X_*` code and a
 * generated no-op handler checkpoints a page it never wrote, which reports swept rows nobody
 * touched. The row projection is the one line an author replaces, and it is exported so the
 * generated test asserts the WORK rather than only the declaration around it.
 */
const backfillSource = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel}: one pass over a chain of rows. The backfill is a job factory, not a ninth
// primitive, so it inherits .enqueue(), retry, cancellation and the manifest row.
// \`BackfillBatch\` comes from @ultimat3/jobs, not @ultimat3/schema: a backfill file imports one package.

import { assert } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import { postgresRepo, tableFor } from '@ultimat3/entity';
import type { BackfillBatch } from '@ultimat3/jobs';
import { backfill } from '@ultimat3/jobs';
import type { ${feature.pascal} } from '../entity';
import { ${feature.camel} } from '../entity';

/** The table as a chain — the seam \`database()\` hands an app, so this sweep reads what a query reads. */
const ${feature.camel}Table = () => tableFor(${feature.camel}, postgresRepo(${feature.camel}));

/**
 * What the sweep writes for one row. Replace the projection with the change this pass exists to
 * make, and keep it IDEMPOTENT: a page replays whole when an attempt is cancelled between the last
 * row and its checkpoint, so the second run of this function must produce the first run's row.
 */
export const ${name.camel}Row = (row: ${feature.pascal}): ${feature.pascal} => ({
  ...row,
  title: row.title.trim(),
});

export const ${name.camel} = backfill({
  name: '${name.kebab}',
  source: ({ ctx }): ReadBuilder<${feature.pascal}> => {
    // \`where({ orgId })\` is what satisfies the tenancy guard, and a sweep with no org would visit
    // every tenant at once — so the actor this run carries has to name one.
    const { orgId } = ctx.actor;
    assert(
      orgId !== undefined,
      '${name.kebab}: the actor running this pass carries no orgId, and a sweep is tenanted',
      'x jobs enqueue ${name.kebab} --actor <a member of the org to sweep>',
    );
    return ${feature.camel}Table().where({ orgId });
  },
  handle: async ({ rows, signal }: BackfillBatch<${feature.pascal}>) => {
    // One page, in its own durable step, at least once. Write through upsertAll, updateWhere or an
    // idempotent statement; never count + 1. The signal is the run cancellation composed with this
    // batch's ceiling, so a cancelled pass stops here instead of writing past its lease.
    signal.throwIfAborted();
    await ${feature.camel}Table().upsertAll(rows.map(${name.camel}Row), { onConflict: ['id'] });
  },
  // batch: 1_000, // rows per step, default. Adjust to balance statement size and retry scope.
  // rate: 5, // batches per second, default. Raise to sweep faster; there is no unthrottled mode.
  // retry: { attempts: 5, backoff: 'exponential' },
});
`;

const backfillTest = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel} sweeps rows a user never asked for, so the two facts worth failing on are its
// durable identity — one live run per name, retried under the same key — and that the row
// projection it applies is idempotent, because a cancelled attempt replays its page whole.

import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import type { ${feature.pascal} } from '../entity';
import { ${name.camel}, ${name.camel}Row } from './${name.kebab}';

// The driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test happens to run next.
beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

const row = (over: Partial<${feature.pascal}> = {}): ${feature.pascal} => ({
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  title: '  needs normalising  ',
  price: { minor: 1000, currency: 'USD' },
  createdAt: new Date(0),
  ...over,
});

jobTest('${name.camel} declares a durable name and retry policy', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.idempotencyKeyFor({})).toBe('${name.kebab}');
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('${name.camel} uses the same idempotency key across attempts', () => {
  expect(${name.camel}.idempotencyKeyFor({})).toBe(${name.camel}.idempotencyKeyFor({}));
});

jobTest('${name.camel} projects itself into the manifest', () => {
  const described = ${name.camel}.describe();
  expect(described.queue).toBe('default');
  expect(described.retry.attempts).toBeGreaterThan(0);
});

jobTest('${name.camel} actually rewrites the row it is handed', () => {
  // The declaration alone cannot fail this: a handler that returned without writing would still
  // enqueue, still checkpoint and still report the page as swept.
  expect(${name.camel}Row(row()).title).toBe('needs normalising');
});

jobTest('${name.camel} is idempotent — a replayed page writes what the first pass wrote', () => {
  // At least once is the contract: an attempt cancelled between the last row and its checkpoint
  // hands this page to the next attempt. Twice through must equal once through.
  const once = ${name.camel}Row(row());
  expect(${name.camel}Row(once)).toEqual(once);
});

jobTest('${name.camel} enqueues once, and dedupes the retry', async () => {
  // One live run per name, forced or not: a second enqueue while the pass is going is the same pass.
  // \`.enqueue()\` is the backfill path — the declared job, queued with no scheduler involved.
  const first = await ${name.camel}.enqueue({});
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue({});
  expect(again.deduped).toBe(true);
});
`;

export function backfillFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/backfills`;
  return [
    { path: `${dir}/${name.kebab}.ts`, contents: backfillSource(name, feature) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: backfillTest(name, feature) },
  ];
}
