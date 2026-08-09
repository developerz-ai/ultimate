// `x g policy <feature>` — one authz rule set, evaluated identically by the HTTP route, the live
// query, the job and the MCP tool. Two authz systems is how frameworks die; the generated test
// pins the denial branch, because a policy that only has passing tests is a policy nobody trusts.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const policySource = (
  feature: NameSet,
): string => `// Authz for the ${feature.kebab} feature. Every branch here is reachable from every surface.
// Predicates are synchronous on purpose: a live query re-evaluates one per subscriber per patch,
// so an await here would be a database round trip per row per connected client.
import { tag } from '@ultimat3/cache';
import { can } from '@ultimat3/policy';

export const ${feature.camel}Tag = tag('${feature.kebab}');

/** What every ${feature.kebab} rule needs to decide. Actions and queries both accept it. */
export interface ${feature.pascal}Scope {
  readonly orgId: string;
}

/** Read is org-scoped: an actor sees rows in their own org and nothing else. */
export const can${feature.pascal}Read = can<${feature.pascal}Scope>(
  '${feature.kebab}:read',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);

/** Write additionally requires the member role — viewers are read-only. */
export const can${feature.pascal}Write = can<${feature.pascal}Scope>(
  '${feature.kebab}:write',
  ({ actor, input }) => {
    if (actor === null || actor.orgId !== input.orgId) return false;
    const roles = actor.roles ?? [];
    return roles.includes('member') || roles.includes('owner');
  },
);
`;

const policyTest = (feature: NameSet): string => `import type { Actor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { can${feature.pascal}Read, can${feature.pascal}Write } from './policy';

const org = '00000000-0000-0000-0000-000000000002';
const actor = (id: string, orgId: string, roles: readonly string[]): Actor => ({
  kind: 'user',
  id,
  orgId,
  roles,
  scopes: [],
});

const viewer = actor('a', org, ['viewer']);
const member = actor('b', org, ['member']);
const outsider = actor('c', '00000000-0000-0000-0000-000000000009', ['owner']);

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
