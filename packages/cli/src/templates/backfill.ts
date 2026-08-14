// `x g backfill` — a one-pass table sweep. The backfill is a factory over job(), not a ninth
// primitive, so it inherits .enqueue(), the retry policy, the cancellation and the manifest row.
// One live run per name: a second enqueue while the pass is going is the same pass.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const backfillSource = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel}: one pass over a chain of rows. The backfill is a job factory, not a ninth
// primitive, so it inherits .enqueue(), retry, cancellation and the manifest row.
// \`BackfillBatch\` comes from @ultimat3/jobs, not @ultimat3/schema: a backfill file imports one package.

import type { ReadBuilder } from '@ultimat3/entity';
import type { BackfillBatch } from '@ultimat3/jobs';
import { backfill } from '@ultimat3/jobs';
import type { ${feature.pascal} } from '../entity';
import * as repo from '../repo';

export const ${name.camel} = backfill({
  name: '${name.kebab}',
  source: ({ ctx }): ReadBuilder<${feature.pascal}> => {
    // Query the ${feature.kebab}s to backfill, tenanted by ctx.actor.orgId.
    // Access the table through your database client or repo functions.
    throw new Error('Backfill source not implemented — add your query here');
  },
  handle: async ({ rows, signal }: BackfillBatch<${feature.pascal}>) => {
    // One page, in a durable step. Await signal to respect timeout and cancellation.
    // Write through upsertAll, updateWhere or an idempotent statement; never count + 1.
    if (rows.length === 0) return;
    signal.throwIfAborted();
    // Placeholder: process the rows after querying them.
    void rows; // silence unused warning; delete this line and use rows
  },
  // batch: 1_000, // rows per step, default. Adjust to balance statement size and retry scope.
  // rate: 5, // batches per second, default. Raise to sweep faster; there is no unthrottled mode.
  // retry: { attempts: 5, backoff: 'exponential' },
});
`;

const backfillTest = (
  name: NameSet,
): string => `import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// The driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test happens to run next.
beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

jobTest('${name.camel} declares a durable name and retry policy', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.idempotencyKeyFor({})).toBe(\`${name.kebab}\`);
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
    { path: `${dir}/${name.kebab}.test.ts`, contents: backfillTest(name) },
  ];
}
