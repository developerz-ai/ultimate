// The tests `x g action` and `x g mutator` write beside the declaration: a `unit` file for its shape
// and handler, a `contract` file for its projections. Split from `action.ts` because the gate types
// a test by its filename, and the two together passed that file's ceiling.

import { sortedImports } from './imports';
import type { NameSet } from './naming';

/** The code the slice's `errors.ts` declares for a missing row. */
const notFoundCode = (feature: NameSet): string =>
  `X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND`;

const ID = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

/** The declaration-shape assertions that differ between the two primitives. */
const shapeTest = (name: NameSet, feature: NameSet, isMutator: boolean): string =>
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
    : `unitTest('${name.camel} is a declared action that invalidates its slice', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('${name.camel}');
  // Without \`cache: { invalidates }\` every cached read of this slice serves the row as it was.
  expect(target.describe().invalidates).toContain(${feature.camel}Tag.entity);
});`;

/**
 * The contract test's preamble. Everything but the target rides only where it is USED: the
 * scaffolded app lints with `noUnusedVariables: error`, so an actor or an input the file never
 * reads would be a lint failure in code nobody typed — which is what a hand-written policy, whose
 * tenancy this generator asserts nothing about, was handed.
 */
const preamble = (
  name: NameSet,
  feature: NameSet,
  isMutator: boolean,
  wrappers: string,
  outsider: boolean,
  /** `testActor` is imported for the outsider. */
  importsActor = outsider,
  /** A contract suite's import of `apps/web/exercise.ts`, the one home of its exercise. */
  exerciseImport?: string,
): string => `${importsActor ? "import { testActor } from '@ultimat3/policy';\n" : ''}import { ${wrappers} } from '@ultimat3/testing';
${exerciseImport === undefined ? '' : `${exerciseImport}\n`}import { ${name.camel} } from './${name.kebab}';
${
  outsider
    ? `
const id = '${ID}';
const orgId = '${ORG}';
const input = { id, orgId${isMutator ? ", title: 'a title'" : ''} };
`
    : ''
}
// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`defineApi\` stamps the same name onto the same object, so each projection of it
// works there with nothing to remember.
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
export interface HandlerShape {
  readonly isMutator: boolean;
  /** The handler reads a row by id and throws `<Feature>NotFoundError` when there is none. */
  readonly lookup: boolean;
  /** The slice still takes the row `x g entity` scaffolds, so the test may store one. */
  readonly storesRow: boolean;
  readonly dbModule: string;
  /**
   * The permission the writer is granted — `<feature>:write` for the policy this generator wrote,
   * the one literal `can('<perm>')` of a handwritten one, or `undefined` when that policy's grant
   * cannot be read, and then no assertion depends on it.
   */
  readonly grant: string | undefined;
  /** The input and the writer name an org: the slice is tenant-scoped, or its policy reads one. */
  readonly org: boolean;
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
  if (shape.grant === undefined) {
    return `
// No handler assertion: ../policy.ts is hand-written and its grant is not one literal can('…'),
// so which actor reaches the handler is the author's to state — add that test here.
`;
  }
  const answer = shape.isMutator ? "{ id, title: 'a title' }" : '{ id }';
  if (!shape.lookup) {
    return `
unitTest('an actor without the grant is refused before the handler runs', async () => {
  const stranger = testActor('stranger'${shape.org ? ', { orgId }' : ''}).actor;
  const refused = await target.as(stranger, input).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('the handler answers a writer${shape.org ? ' in the org' : ''}', async () => {
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

unitTest('the handler reads its row in one statement', async ({ statements }) => {
  const draft = { orgId, title: 'kept', price: { minor: 0, currency: 'USD' } };
  const row = await runWithContext(ctxOf({ actor: writer }), () => repo.insert(draft));
  const before = statements.count();
  await target.as(writer, ${call});
  // Its own lookup and nothing else, on this driver as on Postgres: a read added per row is red.
  expect(statements.count() - before).toBe(1);
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
export const actionUnitTest = (name: NameSet, feature: NameSet, shape: HandlerShape): string => {
  const known = shape.grant !== undefined;
  const stores = known && shape.lookup && shape.storesRow;
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
  ...(known ? ["import { testActor } from '@ultimat3/policy';"] : []),
  `import { ${testing} } from '@ultimat3/testing';`,
  ...(stores ? [`import { driver } from '${shape.dbModule}';`] : []),
])}${shape.isMutator ? '' : `\nimport { ${feature.camel}Tag } from '../policy';`}${stores ? "\nimport * as repo from '../repo';" : ''}
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';
${shape.org ? `const orgId = '${ORG}';\n` : ''}const input = { id${shape.org ? ', orgId' : ''}${shape.isMutator ? ", title: 'a title'" : ''} };
${shape.isMutator ? `\n// The client store's table: the entity's own, so the twin and the server row share one key.\nconst TABLE = '${feature.table}';\n` : ''}
// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`defineApi\` stamps the same name onto the same object, so each projection of it
// works there with nothing to remember.
const target = ${name.camel}.named('${name.camel}');
${
  known
    ? `
// Holds the grant${shape.org ? ' in the org the input names' : ''}: past the policy, so what answers is the handler.
const grant = ['${shape.grant}'];
const writer = testActor('writer', { ${shape.org ? 'orgId, ' : ''}permissions: grant }).actor;
`
    : ''
}${
  stores
    ? `
// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});
`
    : ''
}
${shapeTest(name, feature, shape.isMutator)}

unitTest('${name.camel} rejects input that is not a uuid', async () => {
  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });
  await expect(target.input).toAcceptInput(input);
});
${shape.isMutator ? localTwinTests() : ''}${handlerTests(feature, shape)}`;
};

export const actionContractTest = (
  name: NameSet,
  feature: NameSet,
  isMutator: boolean,
  /** The slice's policy is the one this generator wrote, so its tenancy rule is known. */
  scaffoldPolicy = true,
  /** That policy holds an org rule: false for a slice whose entity names no tenant. */
  orgRule = scaffoldPolicy,
  /** The line importing `apps/web/exercise.ts`'s export, relative to this test (`action-exercise.ts`). */
  exerciseImport = "import { exercise } from '../../../exercise';",
): string => `// ${name.camel}: the contract every action owes, and the foreign-org actor it denies before the
// handler runs. One declaration, every surface.
${preamble(name, feature, isMutator, 'contractTest, expect', orgRule, orgRule, exerciseImport)}
contractTest('${name.camel} passes the action contract', async () => {
  // Four assertions the framework makes for any action, without knowing what this one does:
  // garbage input is rejected, an anonymous actor is denied, the operation reaches the OpenAPI
  // document, and the handler survives 16 generated legal inputs, each rolled back — run as its
  // entry in apps/web/exercise.ts declares, the same entry \`x exercise\` runs.
  for (const contract of target.contract({ exercise })) {
    await contract.run();
  }
});

${
  orgRule
    ? `contractTest('${name.camel} denies a foreign org', async () => {
  // \`.as()\` is the one execution path with the actor swapped, so this denial is the same one
  // HTTP, MCP and the job surface would produce — and no repo call happened to produce it.
  const denied = await target.as(outsider, input).catch((error: unknown) => error);
  expect(denied).toBeUltimateError('X_FORBIDDEN');
});
`
    : scaffoldPolicy
      ? `// No foreign-org assertion: this slice's entity names no tenant, so there is no other org to deny.
`
      : `// No foreign-org assertion: ../policy.ts is hand-written, and whether it checks the org is the
// author's rule to state — add that test here.
`
}
// No MCP tool until it is described: a placeholder description misleads the agent reading it.
contractTest('${name.camel} projects one operation and no tool', () => {
  expect(target.openapi().operationId).toBe('${name.camel}');
  expect(target.mcp?.expose ?? false).toBe(false);
});
`;
