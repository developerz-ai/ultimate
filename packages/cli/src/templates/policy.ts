// `x g policy <feature>` — one authz rule set, evaluated identically by the HTTP route, the live
// query, the job and the MCP tool. Two authz systems is how frameworks die; the generated test
// pins the denial branch, because a policy that only has passing tests is a policy nobody trusts.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const policySource = (
  feature: NameSet,
): string => `// Authz for the ${feature.kebab} feature. Every branch here is reachable from every surface.
import { can, tag } from '@ultimat3/policy';

export const ${feature.camel}Tag = tag('${feature.kebab}');

/** Read is org-scoped: an actor sees rows in their own org and nothing else. */
export const can${feature.pascal}Read = can('${feature.kebab}:read', ({ actor, input }) => {
  if (actor === null) return false;
  return input.orgId === actor.orgId;
});

/** Write additionally requires the member role — viewers are read-only. */
export const can${feature.pascal}Write = can('${feature.kebab}:write', ({ actor, input }) => {
  if (actor === null) return false;
  if (input.orgId !== actor.orgId) return false;
  return actor.roles.includes('member') || actor.roles.includes('owner');
});
`;

const policyTest = (feature: NameSet): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { can${feature.pascal}Read, can${feature.pascal}Write } from './policy';

const org = '00000000-0000-0000-0000-000000000002';
const viewer = { id: 'a', orgId: org, roles: ['viewer'] };
const member = { id: 'b', orgId: org, roles: ['member'] };
const outsider = { id: 'c', orgId: '00000000-0000-0000-0000-000000000009', roles: ['owner'] };

unitTest('${feature.camel} read denies anonymous and cross-org actors', async () => {
  await expect(can${feature.pascal}Read).toDenyPolicy({ actor: null, input: { orgId: org } });
  await expect(can${feature.pascal}Read).toDenyPolicy({ actor: outsider, input: { orgId: org } });
});

unitTest('${feature.camel} write denies a viewer and allows a member', async () => {
  await expect(can${feature.pascal}Write).toDenyPolicy({ actor: viewer, input: { orgId: org } });
  await expect(can${feature.pascal}Write).not.toDenyPolicy({ actor: member, input: { orgId: org } });
});
`;

export function policyFiles(
  rawName: string,
  target: { readonly surfaceDir: string; readonly feature: string },
): readonly GeneratedFile[] {
  const feature = names(rawName.length > 0 ? rawName : target.feature);
  const dir = `${target.surfaceDir}/${target.feature}`;
  return [
    { path: `${dir}/policy.ts`, contents: policySource(feature) },
    { path: `${dir}/policy.test.ts`, contents: policyTest(feature) },
  ];
}
