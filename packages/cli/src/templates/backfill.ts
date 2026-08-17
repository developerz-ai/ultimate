// `x g backfill` — a one-pass table sweep. The backfill is a factory over job(), not a ninth
// primitive, so it inherits .enqueue(), the retry policy, the cancellation and the manifest row.
// One live run per name: a second enqueue while the pass is going is the same pass.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { sliceFoundation } from './slice-foundation';
import { wrapImport } from './wrap';

/**
 * What the entity's value export is called inside the generated file. `x g backfill invoice
 * --feature invoice` is a legal invocation and it emitted `import { invoice } from '../entity'`
 * beside `export const invoice = backfill(...)` — one name, two declarations, which is
 * `lint/suspicious/noRedeclare` in the app's own gate and a genuinely ambiguous reference in TS.
 * Aliased only when it would collide, because every other backfill reads better without one.
 */
const entityRef = (name: NameSet, feature: NameSet): string =>
  name.camel === feature.camel ? `${feature.camel}Entity` : feature.camel;

const entityImport = (name: NameSet, feature: NameSet): string => {
  const local = entityRef(name, feature);
  return local === feature.camel ? feature.camel : `${feature.camel} as ${local}`;
};

/**
 * The chain accessor, wrapped the way Biome would wrap it. Emitted pre-formatted rather than
 * always-wrapped because the formatter joins an arrow body back onto one line when it fits — so a
 * fixed shape is wrong for one name length or the other. Same reason `policy.ts` measures its
 * `definePermissions` line.
 */
const tableLine = (name: NameSet, feature: NameSet): string => {
  const ref = entityRef(name, feature);
  const head = `const ${feature.camel}Table = () =>`;
  const body = `tableFor(${ref}, postgresRepo(${ref}));`;
  return `${head} ${body}`.length <= 100 ? `${head} ${body}` : `${head}\n  ${body}`;
};

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

import type { Ctx } from '@ultimat3/core';
import { assert, hasScope } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import { CROSS_TENANT_SCOPE, postgresRepo, tableFor } from '@ultimat3/entity';
import type { BackfillBatch } from '@ultimat3/jobs';
import { backfill } from '@ultimat3/jobs';
import type { ${feature.pascal} } from '../entity';
import { ${entityImport(name, feature)} } from '../entity';

/** The row this sweep visits, aliased once: every signature below then reads at one width. */
type Row = ${feature.pascal};

/** The table as a chain — the seam \`database()\` hands an app, so this sweep reads what a query reads. */
${tableLine(name, feature)}

/**
 * The rows this pass visits. A one-pass sweep has no single org, so it declares \`tenant: 'none'\`
 * below — which STRIPS the org from the run rather than inheriting the worker's. That makes
 * spanning tenants a capability instead of an accident: the actor this worker runs as has to carry
 * \`tenancy:cross\`, and this is where that is said, before a page is read rather than inside the
 * plan builder. A single-org sweep is the other shape — declare \`tenant: () => '<org id>'\` and put
 * \`.where({ orgId: ctx.actor.orgId })\` back.
 */
const ${name.camel}Scope = (ctx: Ctx): ReadBuilder<Row> => {
  assert(
    hasScope(ctx.actor, CROSS_TENANT_SCOPE),
    '${name.kebab}: this pass spans every tenant and its actor holds no tenancy:cross',
    // A generated \`fix:\` is copied and run verbatim, so it names a command this build SHIPS.
    'x db backfill ${name.kebab} --write --json',
  );
  return ${feature.camel}Table();
};

/**
 * What the sweep writes for one row. Replace the projection with the change this pass exists to
 * make, and keep it IDEMPOTENT: a page replays whole when an attempt is cancelled between the last
 * row and its checkpoint, so the second run of this function must produce the first run's row.
 */
export const ${name.camel}Row = (row: Row): Row => ({
  ...row,
  title: row.title.trim(),
});

export const ${name.camel} = backfill({
  name: '${name.kebab}',
  // A sweep over a table belongs to no one org, so it declares none — and \`'none'\` STRIPS the org
  // rather than inheriting the worker's, so a tenant-scoped read inside the pass fails closed
  // (X_TENANCY_ACTOR_ORG_REQUIRED) instead of reading somebody's rows by accident. A sweep that
  // genuinely spans tenants says so out loud: its work runs inside \`crossTenant(reason, fn)\`, and
  // the reason IS the mechanism. A per-org sweep declares its org instead: \`tenant: () => orgId\`,
  // one enqueue per org.
  tenant: 'none',
  source: ({ ctx }): ReadBuilder<Row> => ${name.camel}Scope(ctx),
  handle: async ({ rows, signal }: BackfillBatch<Row>) => {
    // One page, in its own durable step, at least once. Write through upsertAll, updateWhere or an
    // idempotent statement; never count + 1. The signal is the run cancellation composed with this
    // batch's ceiling, so a cancelled pass stops here instead of writing past its lease.
    signal.throwIfAborted();
    const next = rows.map(${name.camel}Row);
    await ${feature.camel}Table().upsertAll(next, { onConflict: ['id'] });
  },
  // How many rows still NEED the change — never how many the sweep visits. Declare it once
  // \`source\` narrows to the rows that are actually behind (\`.andWhere('publishedAt', 'is', null)\`
  // and the like): then a dry run cannot lie, and a pass that exhausts its source while this still
  // answers above zero fails as X_BACKFILL_STALLED instead of writing a completed row nobody can
  // trust. Left out here because this scaffold re-normalises every row it visits, so a count of
  // the same chain would never reach zero.
  // count: ({ ctx }) => ${name.camel}Scope(ctx).andWhere('publishedAt', 'is', null).count(),
  // batch: 1_000, // rows per step, default. Adjust to balance statement size and retry scope.
  // rate: 5, // batches per second, default. Raise to sweep faster; there is no unthrottled mode.
  // retry: { attempts: 5, backoff: 'exponential' },
  // requires: '20260814120000_add_publish_at', // the migration x db backfill checks first
  // environments: ['staging', 'production'], // omit for every environment — never implied
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
${wrapImport([name.camel, `${name.camel}Row`], `./${name.kebab}`)}

// The driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test happens to run next.
beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

// The durable name this sweep runs under, spelled once — so the assertion below carries the
// backfill's own name and still fits the formatter width the app's \`lint\` step enforces.
const expectedKey = '${name.kebab}';

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
  expect(${name.camel}.idempotencyKeyFor({})).toBe(expectedKey);
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('${name.camel} uses one key across attempts', () => {
  const key = ${name.camel}.idempotencyKeyFor({});
  expect(${name.camel}.idempotencyKeyFor({})).toBe(key);
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

jobTest('${name.camel} replays a page idempotently', () => {
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
    // A sweep is a chain over the entity's own table (`tableFor(entity, postgresRepo(entity))`), so
    // the entity is what it reads and what its generated test builds rows of. No repo call, but
    // `repo.ts` rides along with `entity.ts`: it is that file's only reader.
    ...sliceFoundation(target, ['entity']),
    { path: `${dir}/${name.kebab}.ts`, contents: backfillSource(name, feature) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: backfillTest(name, feature) },
  ];
}
