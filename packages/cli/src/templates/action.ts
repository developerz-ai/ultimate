// `x g action` / `x g mutator` — a server-authoritative command, its policy, and the test that
// pins both. One declaration projects to an HTTP route, an OpenAPI operation, a typed client, a
// job handle, an MCP tool and these tests; the generator writes the declaration and the tests.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const actionSource = (
  name: NameSet,
  feature: NameSet,
): string => `// ${name.camel}: one mutation, server-authoritative. Input is validated before the handler runs
// and the policy is the same object the MCP tool and the HTTP route evaluate.
import { action } from '@ultimat3/action';
import { t } from '@ultimat3/schema';
// One directory up: actions live in \`actions/\`, the feature's errors, policy and repo are the
// slice's own files and are shared by every action in it.
import { ${feature.pascal}NotFoundError } from '../errors';
import { can${feature.pascal}Write, ${feature.camel}Tag } from '../policy';
import * as repo from '../repo';

export const ${name.camel} = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database.
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can${feature.pascal}Write,
  cache: { invalidates: [${feature.camel}Tag] },
  mcp: { expose: true, description: '${name.raw} — generated, edit the description' },
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
import { mutator } from '@ultimat3/action';
import { t } from '@ultimat3/schema';
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

const errorsSource = (
  feature: NameSet,
): string => `// The ${feature.kebab} feature's X_* codes. Never throw a bare Error: an agent reading the failure
// needs the code, the cause and the exact command that fixes it.
import { UltimateError } from '@ultimat3/core';

export class ${feature.pascal}NotFoundError extends UltimateError {
  constructor(input: { id: string }) {
    super({
      code: 'X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND',
      cause: \`no ${feature.kebab} with id \${input.id}\`,
      fix: 'x db studio to confirm the row exists, or pass an id from the list query',
      docs: 'https://ultimate.dev/errors/X_NOT_FOUND',
    });
  }
}
`;

const ID = '00000000-0000-0000-0000-000000000001';
const ORG = '00000000-0000-0000-0000-000000000002';

const actionTest = (
  name: NameSet,
  isMutator: boolean,
): string => `import { contractTest, expect, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';
const orgId = '${ORG}';

unitTest('${name.camel} is a declared ${isMutator ? 'mutator' : 'action'}', () => {
${
  isMutator
    ? `  expect(${name.camel}.describeMutator().kind).toBe('mutator');
  expect(${name.camel}.isMutator).toBe(true);`
    : `  expect(${name.camel}.kind).toBe('action');`
}
});

unitTest('${name.camel} rejects input that is not a uuid', async () => {
  await expect(${name.camel}.def.input).toRejectInput({ id: 'not-a-uuid', orgId${
    isMutator ? ", title: 'a title'" : ''
  } });
  await expect(${name.camel}.def.input).toAcceptInput({ id, orgId${
    isMutator ? ", title: 'a title'" : ''
  } });
});

unitTest('${name.camel} denies an anonymous actor', async () => {
  await expect(${name.camel}.def.policy).toDenyPolicy({ actor: null, input: { orgId } });
});

${
  isMutator
    ? `unitTest('${name.camel} declares a conflict strategy and an optimistic local half', () => {
  expect(${name.camel}.conflict).toBe('server-wins');
  expect(typeof ${name.camel}.applyLocal).toBe('function');
});`
    : `contractTest('${name.camel} is exposed as an MCP tool with a description', () => {
  expect(${name.camel}.def.mcp?.expose).toBe(true);
  expect(${name.camel}.def.mcp?.description ?? '').not.toBe('');
});`
}
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
    {
      path: `${dir}/${name.kebab}.ts`,
      contents: isMutator ? mutatorSource(name, feature) : actionSource(name, feature),
    },
    { path: `${dir}/${name.kebab}.test.ts`, contents: actionTest(name, isMutator) },
    {
      path: `${target.surfaceDir}/${target.feature}/errors.ts`,
      contents: errorsSource(feature),
    },
  ];
}
