// `x g action` / `x g mutator` — a server-authoritative command, its policy, and the test that
// pins both. One declaration projects to an HTTP route, an OpenAPI operation, a typed client, a
// job handle, an MCP tool and these tests; the generator writes the declaration and the tests.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { sliceFoundation } from './slice-foundation';
import { wrapImport } from './wrap';

const actionSource = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel}: one mutation, server-authoritative. Input is validated before the handler runs
// and the policy is the same object the MCP tool and the HTTP route evaluate.
// \`t\` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
// One directory up: actions live in \`actions/\`, the feature's errors, policy and repo are the
// slice's own files and are shared by every action in it.

import { ${feature.pascal}NotFoundError } from '../errors';
${wrapImport([`can${feature.pascal}Write`, `${feature.camel}Tag`], '../policy')}
import * as repo from '../repo';

export const ${name.camel} = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database.
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can${feature.pascal}Write,
  cache: { invalidates: [${feature.camel}Tag] },
  mcp: { expose: true, description: '${name.raw} — edit this description' },
  async handle({ input }) {
    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: row.title };
  },
});
`;

const mutatorSource = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel}: an action with an optimistic local twin. The local half runs against the client
// store immediately; the server half is authoritative and reconciles on conflict.

import { mutator, t } from '@ultimat3/action';
import { ${feature.pascal}NotFoundError } from '../errors';
import { can${feature.pascal}Write } from '../policy';
import * as repo from '../repo';

interface Local${feature.pascal} {
  readonly id: string;
  readonly title: string;
  readonly pending: boolean;
}

export const ${name.camel} = mutator({
  input: t.object({ id: t.uuid, orgId: t.uuid, title: t.string }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can${feature.pascal}Write,
  mcp: { expose: true, description: '${name.raw} — edit this description' },
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
    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: input.title };
  },
  conflict: 'server-wins',
});
`;

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
// object, so \`${name.camel}.tool()\` works there with nothing to remember.
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

const actionUnitTest = (
  name: NameSet,
  feature: NameSet,
  isMutator: boolean,
): string => `// ${name.camel}: its declared shape and the input it refuses. Both are answered by the declaration
// alone, so they belong to the \`unit\` step — the contract projections are next door.
${preamble(name, feature, isMutator, 'expect, unitTest', false)}
${shapeTest(name, isMutator)}

unitTest('${name.camel} rejects input that is not a uuid', async () => {
  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });
  await expect(target.input).toAcceptInput(input);
});
`;

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

contractTest('${name.camel} projects one tool and one operation', () => {
  // Same policy object on both surfaces — an MCP call cannot reach a different authz path.
  expect(target.tool().policy).toBe(target.policy);
  expect(target.tool().description).not.toBe('');
  expect(target.openapi().operationId).toBe('${name.camel}');
});
`;

export interface ActionOptions extends FeatureTarget {
  readonly mutator?: boolean;
}

export function actionFiles(rawName: string, target: ActionOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/actions`;
  const isMutator = target.mutator === true;
  return [
    // The three slice modules this action's source imports — `../errors`, `../policy`, `../repo`
    // (which comes with `../entity`, its row type). Composed rather than assumed: `x g action`
    // into a slice no `x g resource` had created emitted all three imports and wrote none of them.
    ...sliceFoundation(target, ['entity', 'policy', 'errors']),
    {
      path: `${dir}/${name.kebab}.ts`,
      contents: isMutator ? mutatorSource(name, feature) : actionSource(name, feature),
    },
    // TWO test files, because the gate types a test by its FILENAME and this declaration owes two
    // suites: the input parse is a `unit` assertion and the three projections are `contract` ones.
    // Emitted as one file, the contract half ran under `unit` and `x test contract` answered
    // X_TEST_NO_FILES; renaming that one file would have put the `unitTest` in the same bind.
    { path: `${dir}/${name.kebab}.test.ts`, contents: actionUnitTest(name, feature, isMutator) },
    {
      path: `${dir}/${name.kebab}.contract.test.ts`,
      contents: actionContractTest(name, feature, isMutator),
    },
  ];
}
