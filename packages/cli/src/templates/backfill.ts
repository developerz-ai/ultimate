// `x g backfill` — a one-pass table sweep. The backfill is a factory over job(), not a ninth
// primitive, so it inherits .enqueue(), the retry policy, the cancellation and the manifest row.
// One live run per name: a second enqueue while the pass is going is the same pass.

import { stripComments, UltimateError } from '@ultimat3/core';
import type { FeatureTarget } from './entity';
import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { sliceFoundation, sliceTakesScaffoldRow } from './slice-foundation';
import { wrapImport } from './wrap';

/**
 * Working source, never a stub: a generated `throw new Error(…)` carries no `X_*` code and a
 * generated no-op handler checkpoints a page it never wrote, which reports swept rows nobody
 * touched. The row projection is the one line an author replaces, and it is exported so the
 * generated test asserts the WORK rather than only the declaration around it.
 */
const backfillSource = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
): string => `// ${name.camel}: one pass over a chain of rows. The backfill is a job factory, not a ninth
// primitive, so it inherits .enqueue(), retry, cancellation and the manifest row.
// \`BackfillBatch\` comes from @ultimat3/jobs, not @ultimat3/schema: a backfill file imports one package.

${sortedImports([
  "import { assert, type Ctx, hasScope } from '@ultimat3/core';",
  "import { CROSS_TENANT_SCOPE, type ReadBuilder } from '@ultimat3/entity';",
  "import { type BackfillBatch, backfill } from '@ultimat3/jobs';",
  `import { db } from '${dbModule}';`,
])}
import type { ${feature.pascal} } from '../entity';

/** The row this sweep visits, aliased once: every signature below then reads at one width. */
type Row = ${feature.pascal};

/**
 * The rows this pass visits, read through the app's typed handle — the table a query reads. A
 * one-pass sweep has no single org, so it declares \`tenant: 'none'\` below — which STRIPS the org
 * from the run rather than inheriting the worker's. That makes spanning tenants a capability
 * instead of an accident: the actor this worker runs as has to carry \`tenancy:cross\`, and this is
 * where that is said, before a page is read rather than inside the plan builder. A single-org
 * sweep is the other shape — declare \`tenant: () => '<org id>'\`, and the handle scopes the read.
 */
const ${name.camel}Scope = (ctx: Ctx): ReadBuilder<Row> => {
  assert(
    hasScope(ctx.actor, CROSS_TENANT_SCOPE),
    '${name.kebab}: this pass spans every tenant and its actor holds no tenancy:cross',
    // A generated \`fix:\` is copied and run verbatim, so it names a command this build SHIPS.
    'x db backfill ${name.kebab} --write --json',
  );
  return db.${feature.plural};
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
    // One page, in its own durable step, at least once. The signal is the run cancellation
    // composed with this batch's ceiling, so a cancelled pass stops here instead of writing past
    // its lease.
    signal.throwIfAborted();
    // One \`update\` per row, by primary key, and only the column this pass owns — never count + 1.
    // Not \`upsertAll(rows, { onConflict: ['id'] })\`: on a tenant-scoped table a collision judged
    // on \`id\` alone could land on another tenant's row, so the handle refuses it
    // (X_TENANCY_UNSCOPED) and the pass would retry its first page for ever.
    for (const row of rows) {
      const next = ${name.camel}Row(row);
      await db.${feature.plural}.update(row.id, { title: next.title });
    }
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
): string => `// ${name.camel}'s durable identity: one live run per name, retried under the same key. The work
// itself — the pass over real rows and the projection it applies — is the unit suite's, next door.

import { memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// The driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test happens to run next.
beforeAll(() => {
  setJobDriver(memoryJobDriver());
});
afterAll(resetJobDriver);

// The durable name this sweep runs under, spelled once — so the assertion below carries the
// backfill's own name and still fits the formatter width the app's \`lint\` step enforces.
const expectedKey = '${name.kebab}';

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

jobTest('${name.camel} enqueues once, and dedupes the retry', async () => {
  // One live run per name, forced or not: a second enqueue while the pass is going is the same pass.
  // \`.enqueue()\` is the backfill path — the declared job, queued with no scheduler involved.
  const first = await ${name.camel}.enqueue({});
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue({});
  expect(again.deduped).toBe(true);
});
`;

/**
 * The WORK, on the `unit` step: one whole pass, run by an in-process worker over rows in the
 * in-memory driver, and the projection it applies. An app's coverage floor counts the unit suite
 * alone — and a sweep whose handler nothing ever ran is how a body that could not complete shipped.
 */
const backfillUnitTest = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
): string => `// ${name.camel}, SWEPT: one whole pass run by a worker in this process, over rows in the in-memory
// driver. A sweep rewrites rows no user asked it to, so what is worth failing on is that it reaches
// every tenant's rows, writes the projection and nothing else, and that a replay changes nothing.
${sortedImports([
  "import { ctxOf, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { afterEach, expect, unitTest } from '@ultimat3/testing';",
  `import { db, driver } from '${dbModule}';`,
])}
import type { ${feature.pascal} } from '../entity';
${wrapImport([name.camel, `${name.camel}Row`], `./${name.kebab}`)}

const orgA = '00000000-0000-4000-8000-000000000002';
const orgB = '00000000-0000-4000-8000-000000000009';

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: testActor('member', { orgId }).actor }), run);

const store = (orgId: string, title: string): Promise<${feature.pascal}> => {
  const draft = { orgId, title, price: { minor: 1000, currency: 'USD' } };
  return inOrg(orgId, () => db.${feature.plural}.insert(draft));
};

const titlesOf = (orgId: string): Promise<readonly string[]> =>
  inOrg(orgId, async () => (await db.${feature.plural}.all()).map((row) => row.title));

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('one pass rewrites the rows of every tenant, and completes', async ({ runJobs }) => {
  await store(orgA, '  needs normalising  ');
  await store(orgB, ' so does this ');
  const trace = await runJobs(${name.camel}, {});
  // \`completed\`, not retried: a handler the table refuses retries its first page for ever.
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(await titlesOf(orgA)).toEqual(['needs normalising']);
  expect(await titlesOf(orgB)).toEqual(['so does this']);
});

unitTest('the pass writes the projection and nothing else', async ({ runJobs }) => {
  const stored = await store(orgA, ' padded ');
  await runJobs(${name.camel}, {});
  const [swept] = await inOrg(orgA, () => db.${feature.plural}.all());
  expect(swept).toEqualRow({ ...stored, title: 'padded' });
});

unitTest('the projection is idempotent: a replayed page changes nothing', () => {
  // At least once is the contract: an attempt cancelled between the last row and its checkpoint
  // hands this page to the next attempt. Twice through must equal once through.
  const row: ${feature.pascal} = {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: orgA,
    title: '  needs normalising  ',
    price: { minor: 1000, currency: 'USD' },
    createdAt: new Date(0),
  };
  const once = ${name.camel}Row(row);
  expect(once.title).toBe('needs normalising');
  expect(${name.camel}Row(once)).toEqual(once);
});
`;

export interface BackfillOptions extends FeatureTarget {
  /** Every locale the planted entity's admin labels ship for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
  /** The slice's `entity.ts` as it stands on disk, absent when the feature has none yet. */
  readonly sliceEntity?: string;
  /** The slice's `repo.ts` as it stands on disk, absent alongside `sliceEntity`. */
  readonly sliceRepo?: string;
}

/** Every table an `entity.ts` declares, in source order: `entity('court_closures', …)`. */
const declaredTables = (source: string): readonly string[] =>
  [...stripComments(source).matchAll(/\bentity\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );

/**
 * Declared beside its one thrower: `errors.ts` sits at its ceiling. The sweep this generator writes
 * reads the slice's OWN scaffolded table (`db.<plural>`, its `title` and `price`), so a slice whose
 * entities are named otherwise — notificado.co's `deadline`, holding `holidays` and
 * `court_closures` — got `import type { Deadline }`, `db.deadlines` and admin labels for a table
 * that does not exist. Refused before a file is planned; a hand sweep starts from a job.
 */
export class BackfillSliceEntityError extends UltimateError {
  constructor(input: {
    readonly name: string;
    readonly feature: string;
    readonly tables: readonly string[];
  }) {
    const declared = input.tables.length === 0 ? 'no table' : input.tables.join(', ');
    super({
      code: 'X_BACKFILL_SLICE_ENTITY',
      cause: `x g backfill sweeps the ${input.feature} slice's own scaffolded table, and its entity.ts declares ${declared} instead — the generated files would import a row type and a db handle that do not exist`,
      fix: `x g job ${input.name} --feature ${input.feature}   # then declare backfill({ source: db.<one of: ${declared}>, … }) from @ultimat3/jobs in it`,
      meta: { feature: input.feature, tables: [...input.tables] },
    });
  }
}

export function backfillFiles(rawName: string, target: BackfillOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  if (
    target.sliceEntity !== undefined &&
    !sliceTakesScaffoldRow(target, target.sliceEntity, target.sliceRepo)
  ) {
    throw new BackfillSliceEntityError({
      name: name.kebab,
      feature: target.feature,
      tables: declaredTables(target.sliceEntity),
    });
  }
  const dir = `${target.surfaceDir}/${target.feature}/backfills`;
  const dbModule = target.dbModule ?? PLACEHOLDER_DB_MODULE;
  return [
    // A sweep is a chain over the entity's own table, reached through the app's typed handle
    // (`db.<table>`), so the entity is what it reads and what its generated test stores rows of.
    // No repo call, but `repo.ts` rides along with `entity.ts`: it is that file's only reader.
    ...sliceFoundation(target, ['entity'], target.locales),
    { path: `${dir}/${name.kebab}.ts`, contents: backfillSource(name, feature, dbModule) },
    // A sweep IS a job (`backfill()` is a job factory): its durable identity is a `jobTest`, and
    // the gate types a test by its filename.
    { path: `${dir}/${name.kebab}.job.test.ts`, contents: backfillTest(name) },
    // And the pass itself on the `unit` step, against the in-memory driver.
    { path: `${dir}/${name.kebab}.test.ts`, contents: backfillUnitTest(name, feature, dbModule) },
  ];
}
