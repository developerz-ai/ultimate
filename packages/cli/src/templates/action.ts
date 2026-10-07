// `x g action` / `x g mutator` — a server-authoritative command, its policy, and the test that
// pins both. One declaration projects to an HTTP route, an OpenAPI operation, a typed client, a
// job handle, an MCP tool and these tests; the generator writes the declaration and the tests.

import type { FeatureTarget } from './entity';
import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { sliceExports, sliceFoundation, sliceTakesScaffoldRow } from './slice-foundation';
import { wrapImport } from './wrap';

/**
 * The handler's lookup-by-id, or the comment that says what a slice needs before it can have one.
 * `x g resource` writes a slice whose `errors.ts` declares `<Feature>NotFoundError`, and so does
 * the foundation this generator lays under an empty directory; a slice an author wrote by hand
 * (ai-maxxing's `fleet`, with `HostNotFoundError` and `SessionNotFoundError`) declares the errors
 * it has and not this one. Importing it anyway is a file that fails at import.
 */
const missingLookup = (feature: NameSet, entity: boolean): string =>
  entity
    ? `    // No lookup by id: ../errors declares no ${feature.pascal}NotFoundError, and a row that is not
    // there needs one to be thrown for it. Declare it there — the shape \`x g resource\` writes —
    // then read the row through ../repo and throw it when the read answers nothing.`
    : `    // No lookup by id: this feature has no entity, and a generator writing into a slice never
    // invents one. \`x g entity ${feature.kebab}\` declares the table; this body is yours until then.`;

const actionSource = (
  name: NameSet,
  feature: NameSet,
  lookup: boolean,
  entity: boolean,
): string => `// ${name.camel}: one mutation, server-authoritative. Input is validated before the handler runs
// and the policy is the same object the MCP tool and the HTTP route evaluate.
// \`t\` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
// One directory up: actions live in \`actions/\`, the feature's errors, policy and repo are the
// slice's own files and are shared by every action in it.
${lookup ? `\nimport { ${feature.pascal}NotFoundError } from '../errors';\n` : ''}${wrapImport([`can${feature.pascal}Write`, `${feature.camel}Tag`], '../policy')}
${lookup ? "import * as repo from '../repo';\n" : ''}
export const ${name.camel} = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database.
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  output: t.object({ id: t.uuid${lookup ? ', title: t.string' : ''} }),
  policy: can${feature.pascal}Write,
  cache: { invalidates: [${feature.camel}Tag] },
  // No \`mcp\`: a tool's description is what an agent reads to decide to call it, and a placeholder
  // there is worse than no tool. Write one, then \`mcp: { expose: true, description: '…' }\`.
  async handle({ input }) {
${
  lookup
    ? `    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: row.title };`
    : `${missingLookup(feature, entity)}
    return { id: input.id };`
}
  },
});
`;

const mutatorSource = (
  name: NameSet,
  feature: NameSet,
  lookup: boolean,
  entity: boolean,
): string => `// ${name.camel}: an action with an optimistic local twin. The local half runs against the client
// store immediately; the server half is authoritative and reconciles on conflict.

import { mutator, t } from '@ultimat3/action';
${lookup ? `import { ${feature.pascal}NotFoundError } from '../errors';\n` : ''}import { can${feature.pascal}Write } from '../policy';
${lookup ? "import * as repo from '../repo';\n" : ''}
interface Local${feature.pascal} {
  readonly id: string;
  readonly title: string;
  readonly pending: boolean;
}

export const ${name.camel} = mutator({
  input: t.object({ id: t.uuid, orgId: t.uuid, title: t.string }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can${feature.pascal}Write,
  // Required on a mutator (X_MUTATOR_NOT_IDEMPOTENT): the client replays this write under one
  // Idempotency-Key after a dropped response, and the replay answers the first result.
  idempotent: true,
  // No \`mcp\` until a real description is written: see \`x g action\`.
  // tx.table(name) rather than tx.${feature.plural}: the typed accessor exists only once the app
  // augments LocalTables, and generated code cannot assume that has happened yet. The name is the
  // entity's snake_case table, so the local twin and the server row live under one key.
  local(tx, input) {
    tx.table<Local${feature.pascal}>('${feature.table}').update(input.id, {
      title: input.title,
      pending: true,
    });
  },
  async server(_ctx, input) {
${
  lookup
    ? `    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: input.title };`
    : `${missingLookup(feature, entity)}
    return { id: input.id, title: input.title };`
}
  },
  conflict: 'server-wins',
});
`;

/** The code the slice's `errors.ts` declares for a missing row. */
const notFoundCode = (feature: NameSet): string =>
  `X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND`;

const ID = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

/** The declaration-shape assertions that differ between the two primitives. */
const shapeTest = (name: NameSet, isMutator: boolean): string =>
  isMutator
    ? `unitTest('${name.camel} projects both halves and a conflict strategy', () => {
  // The projected names mirror the declaration: local() optimistic, server() authoritative.
  // server() routes through the same invoke() core as every other surface, so it cannot skip
  // the input parse, the policy or the output parse.
  expect(target.describeMutator().kind).toBe('mutator');
  expect(target.conflict).toBe('server-wins');
  expect(typeof target.local).toBe('function');
  expect(typeof target.server).toBe('function');
});`
    : `unitTest('${name.camel} is a declared action', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('${name.camel}');
});`;

/**
 * The preamble both generated tests share. `outsider` rides along only where it is USED: the
 * scaffolded app lints with `noUnusedVariables: error`, so an actor declared in the unit half
 * would be a lint failure in code nobody typed.
 */
const preamble = (
  name: NameSet,
  feature: NameSet,
  isMutator: boolean,
  wrappers: string,
  outsider: boolean,
): string => `${outsider ? "import { testActor } from '@ultimat3/policy';\n" : ''}import { ${wrappers} } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';
const orgId = '${ORG}';
const input = { id, orgId${isMutator ? ", title: 'a title'" : ''} };

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerActions(await import('./actions'))\` stamps the same name onto the same
// object, so each projection of it works there with nothing to remember.
const target = ${name.camel}.named('${name.camel}');
${
  outsider
    ? `
// Holds the grant, wrong org. That is the interesting actor: a denial here is the predicate
// deciding, not the permission check, so this test fails if the tenancy rule is ever dropped.
const outsider = testActor('outsider', {
  orgId: '${OTHER_ORG}',
  permissions: ['${feature.kebab}:write'],
}).actor;
`
    : ''
}`;

/** What the unit test may do with the slice the declaration lives in. */
interface HandlerShape {
  readonly isMutator: boolean;
  /** The handler reads a row by id and throws `<Feature>NotFoundError` when there is none. */
  readonly lookup: boolean;
  /** The slice still takes the row `x g entity` scaffolds, so the test may store one. */
  readonly storesRow: boolean;
  readonly dbModule: string;
}

/**
 * The optimistic half, run against the client store `@ultimat3/testing` ships. A twin is replayed
 * on every rebase, so the two facts worth failing on are the row one application leaves and that a
 * second leaves the same one — and that a row the store never held is not invented.
 */
const localTwinTests = (): string => `
unitTest('the local twin marks the row pending, and a replay lands in the same place', () => {
  const store = memoryLocalTx({ [TABLE]: { [id]: { id, title: 'before', pending: false } } });
  target.local(store.tx, input);
  const once = store.rows(TABLE);
  expect(once).toEqual({ [id]: { id, title: 'a title', pending: true } });
  // A rebase replays the queued write: twice through must equal once through.
  target.local(store.tx, input);
  expect(store.rows(TABLE)).toEqual(once);
});

unitTest('the local twin invents no row the store never held', () => {
  const store = memoryLocalTx();
  target.local(store.tx, input);
  expect(store.rows(TABLE)).toEqual({});
});
`;

/** The authoritative half's cases, refusal first, in the shape the slice earns. */
const handlerTests = (feature: NameSet, shape: HandlerShape): string => {
  const answer = shape.isMutator ? "{ id, title: 'a title' }" : '{ id }';
  if (!shape.lookup) {
    return `
unitTest('an actor without the grant is refused before the handler runs', async () => {
  const stranger = testActor('stranger', { orgId }).actor;
  const refused = await target.as(stranger, input).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('the handler answers a writer in the org', async () => {
  expect(await target.as(writer, input)).toEqual(${answer});
});
`;
  }
  const found = shape.isMutator
    ? "{ id: row.id, title: 'a title' }"
    : "{ id: row.id, title: 'kept' }";
  const call = shape.isMutator
    ? "{ id: row.id, orgId, title: 'a title' }"
    : '{ id: row.id, orgId }';
  return `
unitTest('the handler refuses an id nothing holds', async () => {
  const refused = await target.as(writer, input).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('${notFoundCode(feature)}');
});
${
  shape.storesRow
    ? `
unitTest('the handler answers the row it found', async () => {
  const draft = { orgId, title: 'kept', price: { minor: 0, currency: 'USD' } };
  const row = await runWithContext(ctxOf({ actor: writer }), () => repo.insert(draft));
  const answer = await target.as(writer, ${call});
  expect(answer).toEqual(${found});
});
`
    : ''
}`;
};

/**
 * The unit test: the declaration's shape, the input it refuses, and the HANDLER — run through
 * `.as()`, the one execution path, against the in-memory driver. A mutator's local twin runs
 * against `memoryLocalTx`. The contract projections are next door, in their own suite.
 *
 * A row is stored only in a slice whose row this generator can spell (`sliceTakesScaffoldRow`): a
 * slice an author reshaped has its own columns, and a test that inserted `{ title, price }` into
 * it would be a guess about someone else's table.
 */
const actionUnitTest = (name: NameSet, feature: NameSet, shape: HandlerShape): string => {
  const stores = shape.lookup && shape.storesRow;
  const testing = [
    ...(stores ? ['afterEach'] : []),
    'expect',
    ...(shape.isMutator ? ['memoryLocalTx'] : []),
    'unitTest',
  ].join(', ');
  return `// ${name.camel}: its declared shape, the input it refuses, and what its handler answers — in
// process, so all three belong to the \`unit\` step. The contract projections are next door.
${sortedImports([
  ...(stores ? ["import { ctxOf, runWithContext } from '@ultimat3/core';"] : []),
  "import { testActor } from '@ultimat3/policy';",
  `import { ${testing} } from '@ultimat3/testing';`,
  ...(stores ? [`import { driver } from '${shape.dbModule}';`] : []),
])}${stores ? "\nimport * as repo from '../repo';" : ''}
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';
const orgId = '${ORG}';
const input = { id, orgId${shape.isMutator ? ", title: 'a title'" : ''} };
${shape.isMutator ? `\n// The client store's table: the entity's own, so the twin and the server row share one key.\nconst TABLE = '${feature.table}';\n` : ''}
// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerActions(await import('./actions'))\` stamps the same name onto the same
// object, so each projection of it works there with nothing to remember.
const target = ${name.camel}.named('${name.camel}');

// Holds the grant in the org the input names: past the policy, so what answers is the handler.
const grant = ['${feature.kebab}:write'];
const writer = testActor('writer', { orgId, permissions: grant }).actor;
${
  stores
    ? `
// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});
`
    : ''
}
${shapeTest(name, shape.isMutator)}

unitTest('${name.camel} rejects input that is not a uuid', async () => {
  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });
  await expect(target.input).toAcceptInput(input);
});
${shape.isMutator ? localTwinTests() : ''}${handlerTests(feature, shape)}`;
};

const actionContractTest = (
  name: NameSet,
  feature: NameSet,
  isMutator: boolean,
): string => `// ${name.camel}: the contract every action owes, and the foreign-org actor it denies before the
// handler runs. One declaration, every surface.
${preamble(name, feature, isMutator, 'contractTest, expect', true)}
contractTest('${name.camel} passes the action contract', async () => {
  // Three assertions the framework makes for any action, without knowing what this one does:
  // garbage input is rejected, an anonymous actor is denied, and the operation reaches the
  // OpenAPI document. \`.contract()\` is the projection; this loop just runs it.
  for (const contract of target.contract()) await contract.run();
});

contractTest('${name.camel} denies a foreign org', async () => {
  // \`.as()\` is the one execution path with the actor swapped, so this denial is the same one
  // HTTP, MCP and the job surface would produce — and no repo call happened to produce it.
  const denied = await target.as(outsider, input).catch((error: unknown) => error);
  expect(denied).toBeUltimateError('X_FORBIDDEN');
});

// No MCP tool until it is described: a placeholder description misleads the agent reading it.
contractTest('${name.camel} projects one operation and no tool', () => {
  expect(target.openapi().operationId).toBe('${name.camel}');
  expect(target.mcp?.expose ?? false).toBe(false);
});
`;

export interface ActionOptions extends FeatureTarget {
  readonly mutator?: boolean;
  /**
   * The slice's `errors.ts` as it stands on disk, or absent when the slice has none yet. Absent,
   * the foundation writes one declaring `<Feature>NotFoundError` and the action may throw it;
   * present, the file is the author's and is never rewritten, so the action throws it only when
   * `sliceExports` finds it there.
   */
  readonly sliceErrors?: string;
  /**
   * The slice's `entity.ts`, or absent when the feature has none. Absent, the action reads no row
   * and the generator writes no entity — only `x g entity` and `x g resource` create a feature's
   * data. `x g resource` passes the entity it is writing in the same run.
   */
  readonly sliceEntity?: string;
  /** The slice's `repo.ts` as it stands on disk, or absent alongside `sliceEntity`. */
  readonly sliceRepo?: string;
}

export function actionFiles(rawName: string, target: ActionOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/actions`;
  const isMutator = target.mutator === true;
  const entity = target.sliceEntity !== undefined;
  const lookup =
    entity &&
    (target.sliceErrors === undefined ||
      sliceExports(target.sliceErrors, `${feature.pascal}NotFoundError`));
  return [
    // The three slice modules this action's source imports — `../errors`, `../policy`, `../repo`
    // (which comes with `../entity`, its row type). Composed rather than assumed: `x g action`
    // into a slice no `x g resource` had created emitted all three imports and wrote none of them.
    // With no entity, only the policy: a lookup-free body imports neither ../errors nor ../repo.
    ...sliceFoundation(target, entity ? ['entity', 'policy', 'errors'] : ['policy']),
    {
      path: `${dir}/${name.kebab}.ts`,
      contents: isMutator
        ? mutatorSource(name, feature, lookup, entity)
        : actionSource(name, feature, lookup, entity),
    },
    // TWO test files, because the gate types a test by its FILENAME and this declaration owes two
    // suites: the input parse is a `unit` assertion and the three projections are `contract` ones.
    // Emitted as one file, the contract half ran under `unit` and `x test contract` answered
    // X_TEST_NO_FILES; renaming that one file would have put the `unitTest` in the same bind.
    {
      path: `${dir}/${name.kebab}.test.ts`,
      contents: actionUnitTest(name, feature, {
        isMutator,
        lookup,
        storesRow: sliceTakesScaffoldRow(target, target.sliceEntity, target.sliceRepo),
        dbModule: target.dbModule ?? PLACEHOLDER_DB_MODULE,
      }),
    },
    {
      path: `${dir}/${name.kebab}.contract.test.ts`,
      contents: actionContractTest(name, feature, isMutator),
    },
  ];
}
