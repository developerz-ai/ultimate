// `x g query <name> [--live]` — a read. Live queries must be deterministic and bounded, so the
// generated declaration always carries `orderBy` + `limit` and the generated test pins them:
// an unbounded live query is a memory leak that only shows up under load.

import type { FeatureTarget } from './entity';
import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { sliceFoundation, sliceTakesScaffoldRow } from './slice-foundation';
import { wrapImport } from './wrap';

/** A live read always fans out fresh, so a TTL on it would only ever be dead configuration. */
const cacheLine = (feature: NameSet, live: boolean): string =>
  live ? '' : `\n  cache: { tags: [${feature.camel}Tag], ttlMs: 30_000 },`;

const querySource = (
  name: NameSet,
  feature: NameSet,
  live: boolean,
): string => `// ${name.camel}: a ${live ? 'live (subscribable)' : 'one-shot'} read over ${feature.pluralKebab}.
// Bounded and ordered — required for${live ? ' live queries' : ' predictable pagination'}.
// \`t\` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import type { ${feature.pascal} } from '../entity';
${wrapImport(
  live ? [`can${feature.pascal}Read`] : [`can${feature.pascal}Read`, `${feature.camel}Tag`],
  '../policy',
)}
import * as repo from '../repo';

// No \`orgId\` in the input, and none in the policy: \`repo.list\` reads through the typed handle,
// which scopes every read to the ACTOR's org, and a live window is keyed by the subscriber's
// tenant. One source of tenancy — a parameter would be a second one a caller could set.
export const ${name.camel} = query({
  input: t.object({ limit: t.number.default(50) }),
  policy: can${feature.pascal}Read,
  live: ${String(live)},${cacheLine(feature, live)}
  // Opt-in, unlike an action's tool: a read hands rows to an agent, so silence exposes nothing.
  mcp: { expose: true, description: '${name.raw} — edit this description' },
  sql: ({ limit }) =>
    // \`feature.table\`, not the kebab plural: \`from()\` quotes the identifier into the SQL text,
    // and the entity created the table as snake_case.
    from<${feature.pascal}>('${feature.table}', () => repo.list(limit))
      // Newest first — \`repo.list\`'s own order. These two lines are ONE read spelled twice: the
      // thunk is what the in-memory driver answers and this chain is the SQL Postgres runs, so a
      // direction that differs here is a bounded page holding different rows on each.
      .orderBy('createdAt', 'desc')
      // The primary key last is what makes the order TOTAL: \`createdAt\` alone ties, and two
      // rows that tie can swap between evaluations — a bounded read then drops one and repeats
      // the other, and a live subscription patches a row it never sent.
      .orderBy('id')
      .limit(limit),
});
`;

const queryTest = (name: NameSet, feature: NameSet, shape: ReadShape): string => {
  const { live } = shape;
  const wrapper = live ? 'liveTest' : 'unitTest';
  // A one-shot query's file carries the read cases too, so it imports what they need; a live
  // query's declaration suite reads nothing and imports only its own.
  const subscribes = live && shape.storesRow;
  const imports = subscribes
    ? [
        "import { createContext, frozenClock, runWithContext } from '@ultimat3/core';",
        `import { afterEach, expect, ${wrapper} } from '@ultimat3/testing';`,
        `import { driver } from '${shape.dbModule}';`,
      ]
    : live
      ? [`import { expect, ${wrapper} } from '@ultimat3/testing';`]
      : readImports(shape, ['expect', wrapper]);
  const repo = shape.storesRow
    ? `${subscribes ? `\nimport type { ${feature.pascal} } from '../entity';` : ''}\nimport * as repo from '../repo';`
    : '';
  return `// ${name.camel}: the shape it reads, the policy it asserts, and the actor it refuses. The read is
// declarative, so what a test can get wrong is the authz, and that is what this pins.
${sortedImports([
  ...imports,
  "import { testActor } from '@ultimat3/policy';",
  subscribes
    ? "import { registerQuery, sourceFor } from '@ultimat3/query';"
    : "import { sourceFor } from '@ultimat3/query';",
])}${repo}
import { ${name.camel} } from './${name.kebab}';
${live && !shape.storesRow ? '' : ORG_LINE}
// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerQueries(await import('./${live ? 'live' : 'queries'}'))\` stamps the same name
// onto the same object.
const target = ${name.camel}.named('${name.camel}');

// Holds the grant and no org — so a denial here is the predicate deciding, not the grant.
const orgless = testActor('orgless', { permissions: ['${feature.kebab}:read'] }).actor;

${wrapper}('${name.camel} is a declared ${live ? 'live ' : ''}query', () => {
  expect(target.kind).toBe('query');
  expect(target.isLive).toBe(${String(live)});
});

${wrapper}('${name.camel} is bounded and TOTALLY ordered', async () => {
  // The SQL text is the contract an agent reads to self-correct, so assert on it, not on a
  // shape. \`sourceFor\` is the one read path — it parses the input and builds the source exactly
  // as a request does. \`actor: null\` gives the call a context of its own rather than borrowing
  // an ambient one, and \`unenforced\` states WHY the policy is skipped: the escape hatch takes a
  // written reason, never a boolean, because a boolean reads exactly like forgetting the policy.
  const source = await sourceFor(
    target,
    { limit: 50 },
    {
      actor: null,
      unenforced: 'a scaffolded test asserts the SQL text; the policy is asserted separately',
    },
  );
  const { sql } = source.toSQL();
  const text = sql.toLowerCase();
  // Newest first, as \`repo.list\` — the in-memory half of this same read — returns them.
  expect(text).toContain('order by "createdat" desc');
  expect(text).toContain('limit');
  // "ordered" is not enough. Dropping the id tiebreak still leaves an ORDER BY, so asserting on
  // its presence alone would keep passing while the read went non-deterministic under ties.
  expect(text.slice(text.lastIndexOf('order by'))).toContain('id');
});

${wrapper}('${name.camel} denies an orgless actor before a read', async () => {
  // \`.as()\` is the one read path with the actor swapped: validate, authorize, then read. The
  // denial lands before any SQL executes, which is why this needs no database.
  const denied = await target.as(orgless, { limit: 50 }).catch((error: unknown) => error);
  expect(denied).toBeUltimateError('X_FORBIDDEN');
});

${wrapper}('${name.camel} is offered to agents as a read', () => {
  // \`@ultimat3/mcp\`'s \`toolFrom\` serves this block as a read (\`mutates: false\`), through
  // \`.as()\` under this same policy — an agent cannot reach a different authz path.
  expect(target.kind).toBe('query');
  expect(target.mcp?.expose).toBe(true);
});
${subscribes ? subscribeTest(name, feature) : ''}`;
};

/**
 * The REAL subscribe path, with two orgs: a sync node in this process (the `subscribe` fixture),
 * never `.as(actor)`. `.as()` installs a request context of its own, so a live source that
 * leaves its tenant to the acting actor — which is what the query above does, through
 * `repo.list` — read fine there while every real subscriber was answered `X_TENANCY_UNSCOPED`.
 * Two orgs, a snapshot and a write: the window a subscriber is served from is its own org's.
 */
const subscribeTest = (name: NameSet, feature: NameSet): string => `
// The module's own export under its own name — what \`defineApi\` does at boot — so a subscribe
// frame naming it reaches this declaration.
const live = registerQuery('${name.camel}', ${name.camel});

type Row = ${feature.pascal};

const otherOrg = '${OTHER_ORG}';

const readerOf = (org: string) =>
  testActor('reader', { orgId: org, permissions: ['${feature.kebab}:read'] }).actor;

// The request clock, so \`createdAt\` is an instant this file chose and "newest" is decidable.
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (org: string, title: string) => {
  const draft = { orgId: org, title, price: { minor: 0, currency: 'USD' } };
  const writer = createContext({ actor: testActor('writer', { orgId: org }).actor, clock });
  return runWithContext(writer, () => repo.insert(draft));
};

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

liveTest('two orgs subscribe: each is sent its own rows and writes', async ({ subscribe }) => {
  await store(orgId, 'ours');
  await store(otherOrg, 'theirs');
  // The REAL subscribe path — a sync node in this process — and never \`.as(actor)\`: that
  // installs a request context of its own, so a source read with no tenant passes there and is
  // X_TENANCY_UNSCOPED for every real subscriber.
  // ONE input for both: which org a window holds is the subscriber's, never a parameter.
  const input = { limit: 50 };
  const ours = await subscribe<Row>(live, input, readerOf(orgId));
  const theirs = await subscribe<Row>(live, input, readerOf(otherOrg));
  expect(ours.rows().map((row) => row.title)).toEqual(['ours']);
  expect(theirs.rows().map((row) => row.title)).toEqual(['theirs']);

  // A write after the snapshot reaches its own org's subscriber as a patch — placed first, the
  // order the declaration names — and nobody else's.
  clock.advance(1000);
  await store(orgId, 'ours too');
  await ours.settled();
  await theirs.settled();
  expect(ours.rows().map((row) => row.title)).toEqual(['ours too', 'ours']);
  expect(theirs.rows().map((row) => row.title)).toEqual(['theirs']);
  expect(theirs.patches()).toEqual([]);
});
`;

const ORG = '00000000-0000-4000-8000-000000000002';

/** The org the reader and its rows belong to — an actor's, never the read's input. */
const ORG_LINE = `
// The org the reader and the stored rows belong to: the ACTOR's, never a field of the input.
const orgId = '${ORG}';
`;
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

/** What the read test may do with the slice the query reads. */
interface ReadShape {
  readonly live: boolean;
  /** The slice still takes the row `x g entity` scaffolds, so the test may store some. */
  readonly storesRow: boolean;
  readonly dbModule: string;
}

/**
 * Rows, stored and read back: the case that runs the thunk AND the order the declaration puts on
 * it. Three rows a second apart, a page of two — so an order that is not newest-first, a missing
 * bound and another org's row each fail it on their own.
 */
const storedRowsTest = (): string => `
const otherOrg = '${OTHER_ORG}';

// The request clock, so \`createdAt\` is an instant this file chose and "newest" is decidable.
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (owner: string, title: string) => {
  const draft = { orgId: owner, title, price: { minor: 0, currency: 'USD' } };
  const writer = createContext({ actor: testActor('writer', { orgId: owner }).actor, clock });
  return runWithContext(writer, () => repo.insert(draft));
};

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('stored rows read back newest first, bounded, and never another org', async () => {
  for (const title of ['first', 'second', 'third']) {
    await store(orgId, title);
    clock.advance(1000);
  }
  await store(otherOrg, 'theirs');
  // The declaration's order over the repo's rows: what the SQL names on Postgres, read here
  // from the in-memory driver. A page of two is the two NEWEST, on both.
  const page = await target.as(member, { limit: 2 });
  expect(page.map((row) => row.title)).toEqual(['third', 'second']);
  // The same input, an actor in the other org: its own row, and nothing of this org's.
  const outsider = testActor('outsider', { orgId: otherOrg, permissions: [read] }).actor;
  const theirs = await target.as(outsider, { limit: 50 });
  expect(theirs.map((row) => row.title)).toEqual(['theirs']);
});
`;

/**
 * The READ, executed — the half of a query a declaration test never runs. `.as()` is the one read
 * path: parse, authorize, then read through the repo, which under `bun test` is the in-memory
 * driver. For a live query this is its own file, because the `.live.test.ts` beside it belongs to
 * the `live` step and an app's coverage floor counts the unit suite alone.
 *
 * Rows are stored only in a slice whose row this generator can spell (`sliceTakesScaffoldRow`):
 * one an author reshaped has its own columns, and the refusal and the empty read need none.
 *
 * Every actor is `testActor(…).actor` — the one fixture builder, and an `Actor`, so the stored-row
 * case builds its context from it directly.
 */
const readCases = (
  feature: NameSet,
  shape: ReadShape,
): string => `// The read grant, named once so every line below fits the formatter's width at any feature name.
const read = '${feature.kebab}:read';

// A member of the org, holding the read grant and nothing else.
const member = testActor('member', { orgId, permissions: [read] }).actor;

unitTest('a caller with no grant is refused before the read', async () => {
  const stranger = testActor('stranger', { orgId }).actor;
  const refused = await target.as(stranger, { limit: 50 }).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('the read runs as its caller: an org with no rows reads empty', async () => {
  // Through the policy, the source and the repo — every line of the declaration, against the
  // in-memory driver.
  expect(await target.as(member, { limit: 50 })).toEqual([]);
});
${shape.storesRow ? storedRowsTest() : ''}`;

/** The imports the read cases need, over whatever the file they land in already imports. */
const readImports = (shape: ReadShape, testing: readonly string[]): readonly string[] => [
  ...(shape.storesRow
    ? ["import { createContext, frozenClock, runWithContext } from '@ultimat3/core';"]
    : []),
  `import { ${[...(shape.storesRow ? ['afterEach'] : []), ...testing].join(', ')} } from '@ultimat3/testing';`,
  ...(shape.storesRow ? [`import { driver } from '${shape.dbModule}';`] : []),
];

/** A live query's unit half, as its own file: the suite beside it runs on the `live` step. */
const liveReadTest = (
  name: NameSet,
  feature: NameSet,
  shape: ReadShape,
): string => `// ${name.camel}, READ: what a caller gets back, through the repo and the in-memory driver. The
// subscription — the snapshot and the patches a write produces — is the live suite's, next door.
${sortedImports([...readImports(shape, ['expect', 'unitTest']), "import { testActor } from '@ultimat3/policy';"])}${shape.storesRow ? "\nimport * as repo from '../repo';" : ''}
import { ${name.camel} } from './${name.kebab}';

const orgId = '${ORG}';

// Named here because every projection needs a stable name and this file does not boot the app.
const target = ${name.camel}.named('${name.camel}');

${readCases(feature, shape)}`;

export interface QueryOptions extends FeatureTarget {
  readonly live?: boolean;
  /** Every locale the planted entity's admin labels ship for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
  /**
   * The slice's `entity.ts`, or absent when the feature has none yet. Decides one thing: whether
   * the unit test may STORE rows (`sliceTakesScaffoldRow`). `x g resource` passes the entity it is
   * writing in the same run; `x g query` reads the one on disk.
   */
  readonly sliceEntity?: string;
  /** The slice's `repo.ts` as it stands on disk, or absent alongside `sliceEntity`. */
  readonly sliceRepo?: string;
}

export function queryFiles(rawName: string, target: QueryOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const live = target.live === true;
  const dir = `${target.surfaceDir}/${target.feature}/${live ? 'live' : 'queries'}`;
  const shape: ReadShape = {
    live,
    storesRow: sliceTakesScaffoldRow(target, target.sliceEntity, target.sliceRepo),
    dbModule: target.dbModule ?? PLACEHOLDER_DB_MODULE,
  };
  return [
    // A read declares the row type it returns (`../entity`), the rule that admits it (`../policy`)
    // and the one module allowed to query the table (`../repo`) — all three are the slice's, and
    // `--live` changes only which directory this file lands in.
    ...sliceFoundation(target, ['entity', 'policy'], target.locales),
    { path: `${dir}/${name.kebab}.ts`, contents: querySource(name, feature, live) },
    // The suffix follows the WRAPPER, which follows `--live`: a `liveTest` in a plain
    // `<name>.test.ts` runs under `unit`, so `x test live` had no files in an app full of them.
    {
      path: `${dir}/${name.kebab}${live ? '.live' : ''}.test.ts`,
      contents: live
        ? queryTest(name, feature, shape)
        : `${queryTest(name, feature, shape)}\n${readCases(feature, shape)}`,
    },
    // A live read's unit half, in its own file: the suite above runs on the `live` step.
    ...(live
      ? [{ path: `${dir}/${name.kebab}.test.ts`, contents: liveReadTest(name, feature, shape) }]
      : []),
  ];
}
