// `x g resource`'s create action: a real insert. It used to be `x g action`'s generic body — read a
// row by id, throw NotFound — so the route the resource named `create` could never create, and its
// input was `{ id, orgId }` while the form posted `{ title }`. The input is the entity's own view of
// the columns a caller supplies; the org comes from the actor, never from the body.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { wrapImport, wrapList } from './wrap';

/** The columns a caller supplies: the resource entity's, minus `id`, `orgId` and `createdAt`. */
export const CREATE_COLUMNS = ['title', 'price'] as const;

const createSource = (
  feature: NameSet,
): string => `// create${feature.pascal}: inserts one ${feature.kebab} in the caller's org and returns it.
// The input is a view of the entity's own columns, so a column added there is one edit here —
// the list below — and never a second schema to keep in step.

import { action } from '@ultimat3/action';
import { tenancyActorOrgRequired } from '@ultimat3/entity';
${wrapImport([`${feature.pascal}View`, feature.camel], '../entity')}
${wrapImport([`can${feature.pascal}Create`, `${feature.camel}Tag`], '../policy')}
import * as service from '../service';

/** What a caller supplies. \`id\`, \`orgId\` and \`createdAt\` are the server's to write. */
${wrapList(
  '',
  `export const Create${feature.pascal}Input = ${feature.camel}.$view([`,
  CREATE_COLUMNS.map((column) => `'${column}'`),
  ']);',
)}

export const create${feature.pascal} = action({
  input: Create${feature.pascal}Input,
  output: ${feature.pascal}View,
  policy: can${feature.pascal}Create,
  cache: { invalidates: [${feature.camel}Tag] },
  // No \`mcp\`: an MCP tool's description IS what an agent reads to decide to call it, and a
  // placeholder there is worse than no tool. Write one, then \`mcp: { expose: true, description }\`.
  async handle({ input, ctx }) {
    // The tenant is the actor's. The policy already refused an actor with none; this is the same
    // fact for the type checker, and the framework's own refusal if a caller skips the policy.
    const orgId = ctx.actor.orgId;
    if (typeof orgId !== 'string' || orgId === '') {
      throw tenancyActorOrgRequired({
        entityName: '${feature.camel}',
        operation: 'create',
        actorId: ctx.actor.id,
        actorKind: ctx.actor.kind,
      });
    }
    return service.create({ ...input, orgId });
  },
});
`;

const ORG = '00000000-0000-4000-8000-000000000002';

const createUnitTest = (
  feature: NameSet,
): string => `// create${feature.pascal}: its declared shape and the input it refuses — answered by the
// declaration alone, so they belong to the \`unit\` step.
import { expect, unitTest } from '@ultimat3/testing';
import { create${feature.pascal} } from './create-${feature.kebab}';

const target = create${feature.pascal}.named('create${feature.pascal}');
const input = { title: 'A ${feature.kebab}', price: { minor: 1200, currency: 'USD' } };

unitTest('create${feature.pascal} is a declared action', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('create${feature.pascal}');
});

unitTest('create${feature.pascal} takes the columns a caller supplies', async () => {
  await expect(target.input).toAcceptInput(input);
  await expect(target.input).toRejectInput({ price: input.price });
});
`;

const createContractTest = (
  feature: NameSet,
): string => `// create${feature.pascal}: the contract every action owes, and the orgless actor it denies before
// the handler runs — the org a row is written under is the actor's, so an actor with none is refused.
import { testActor } from '@ultimat3/policy';
import { contractTest, expect } from '@ultimat3/testing';
import { create${feature.pascal} } from './create-${feature.kebab}';

const target = create${feature.pascal}.named('create${feature.pascal}');
const input = { title: 'A ${feature.kebab}', price: { minor: 1200, currency: 'USD' } };

// Holds the grant and belongs to no org: the denial is the predicate deciding, not the grant.
const orgless = testActor('orgless', { permissions: ['${feature.kebab}:write'] }).actor;
// And one that holds both, so the refusal above is not simply "every actor is refused".
const writer = testActor('writer', {
  orgId: '${ORG}',
  permissions: ['${feature.kebab}:write'],
}).actor;

contractTest('create${feature.pascal} passes the action contract', async () => {
  for (const contract of target.contract()) await contract.run();
});

contractTest('create${feature.pascal} needs an actor with an org', async () => {
  expect(await target.as(orgless, input).catch((error: unknown) => error)).toBeUltimateError(
    'X_FORBIDDEN',
  );
  await expect(target.policy).not.toDenyPolicy({ actor: writer, input });
});

contractTest('create${feature.pascal} projects one operation', () => {
  expect(target.openapi().operationId).toBe('create${feature.pascal}');
});
`;

/** The create action and its two suites, under `<slice>/actions/create-<feature>`. */
export function resourceCreateFiles(rawName: string, sliceDir: string): readonly GeneratedFile[] {
  const feature = names(rawName);
  const dir = `${sliceDir}/actions`;
  return [
    { path: `${dir}/create-${feature.kebab}.ts`, contents: createSource(feature) },
    { path: `${dir}/create-${feature.kebab}.test.ts`, contents: createUnitTest(feature) },
    {
      path: `${dir}/create-${feature.kebab}.contract.test.ts`,
      contents: createContractTest(feature),
    },
  ];
}
