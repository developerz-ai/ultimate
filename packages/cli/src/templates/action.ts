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
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { ${feature.pascal}NotFoundError } from './errors';
import { ${feature.camel}Tag } from './policy';
import * as repo from './repo';

export const ${name.camel} = action({
  input: t.object({ id: t.uuid }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can('${feature.kebab}:write', ({ actor, input }) =>
    actor !== null && repo.byId(input.id).then((row) => row?.orgId === actor.orgId),
  ),
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
import { ${feature.pascal}NotFoundError } from './errors';
import * as repo from './repo';

export const ${name.camel} = mutator({
  local(tx, { id }: { id: string }) {
    tx.${feature.plural}.update(id, (row) => ({ ...row, pending: true }));
  },
  async server(_ctx, { id }: { id: string }) {
    const row = await repo.byId(id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id });
    return { id: row.id, title: row.title };
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

const actionTest = (
  name: NameSet,
  isMutator: boolean,
): string => `import { expect } from 'bun:test';
import { contractTest, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

unitTest('${name.camel} is a declared ${isMutator ? 'mutator' : 'action'}', () => {
  expect(${name.camel}.kind).toBe('${isMutator ? 'mutator' : 'action'}');
});

${
  isMutator
    ? `unitTest('${name.camel} declares a conflict strategy and both halves', () => {
  expect(${name.camel}.conflict).toBe('server-wins');
  expect(typeof ${name.camel}.local).toBe('function');
  expect(typeof ${name.camel}.server).toBe('function');
});`
    : `unitTest('${name.camel} rejects input that is not a uuid', async () => {
  await expect(${name.camel}.input).toRejectInput({ id: 'not-a-uuid' });
  await expect(${name.camel}.input).toAcceptInput({
    id: '00000000-0000-0000-0000-000000000001',
  });
});

unitTest('${name.camel} denies an anonymous actor', async () => {
  await expect(${name.camel}.policy).toDenyPolicy({
    actor: null,
    input: { id: '00000000-0000-0000-0000-000000000001' },
  });
});

contractTest('${name.camel} is exposed as an MCP tool with a description', () => {
  expect(${name.camel}.mcp?.expose).toBe(true);
  expect(${name.camel}.mcp?.description.length).toBeGreaterThan(0);
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
