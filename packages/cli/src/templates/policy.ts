// `x g policy <feature>` — one authz rule set, evaluated identically by the HTTP route, the live
// query, the job and the MCP tool. Two authz systems is how frameworks die; the generated test
// pins the denial branch, because a policy that only has passing tests is a policy nobody trusts.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { wrapList } from './wrap';

/** Biome would rewrap this itself, so the generator emits the already-formatted form. */
const permissionSet = (feature: NameSet): string =>
  wrapList(
    '',
    `export const ${feature.camel}Permissions = definePermissions([`,
    [`'${feature.kebab}:read'`, `'${feature.kebab}:write'`],
    ']);',
  );

const policySource = (
  feature: NameSet,
): string => `// Authz for the ${feature.kebab} feature. Every branch here is reachable from every surface.
// Predicates are synchronous on purpose: a live query re-evaluates one per subscriber per patch,
// so an await here would be a database round trip per row per connected client.
//
// A predicate always receives { input, actor, row, ctx }, whichever surface called it. These rules
// decide on the input, so row is null. A rule about an already-loaded row reads row instead —
// never reach for a row through input:
//   can<${feature.pascal}Scope, ${feature.pascal}Row>('${feature.kebab}:write', ({ actor, row }) =>
//     row?.ownerId === actor?.id)

import { tag } from '@ultimat3/cache';
import { can, definePermissions } from '@ultimat3/policy';

// The permission set, declared rather than assumed. The augmentation narrows \`can()\` to these
// strings, so a typo is a build error instead of a rule that silently never matches; the
// definePermissions() call is the same set at runtime, and it has to run before any can() below.
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    '${feature.kebab}:read': true;
    '${feature.kebab}:write': true;
  }
}

${permissionSet(feature)}

/** What a write invalidates and a read depends on — one tag, both directions. */
export const ${feature.camel}Tag = tag('${feature.kebab}');

/** What every ${feature.kebab} rule needs to decide. Actions and queries both accept it. */
export interface ${feature.pascal}Scope {
  readonly orgId: string;
}

// \`can()\` checks the grant first and the predicate second, so a denial distinguishes "you may
// never do this" from "you may, but not in that org" — an agent can act on the difference.
// The predicates below add tenancy only; the grant is never re-checked by hand.

/** Read is org-scoped: an actor sees rows in their own org and nothing else. */
export const can${feature.pascal}Read = can<${feature.pascal}Scope>(
  '${feature.kebab}:read',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);

/** Write is the same tenancy rule on a second permission — grant the two separately in roles. */
export const can${feature.pascal}Write = can<${feature.pascal}Scope>(
  '${feature.kebab}:write',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);
`;

const policyTest = (
  feature: NameSet,
): string => `// The ${feature.kebab} rules, from the DENIAL side: anonymous, cross-org, and the actor holding
// only read. A policy whose tests all pass is a policy nobody has tried to get past.
import { testActor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { can${feature.pascal}Read, can${feature.pascal}Write } from './policy';

const org = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';

// Direct grants rather than roles: defineRoles() MERGES into one app-global map that outlives this
// file, so a role installed here would still be granting permissions to every later test in the
// process — and a second test declaring the same name differently is X_ROLE_REDEFINED rather than
// an override. The app's roles live in apps/web/shared/roles.ts, once. \`permissions\` is the same
// check one layer down.
// The two grants and the org, each named once. Not decoration: every assertion below then carries
// the feature's own name and still fits the formatter's width, whatever that name is — a generated
// file the app's \`lint\` step rewrites is a red gate over code nobody typed.
const read = '${feature.kebab}:read';
const write = '${feature.kebab}:write';
const input = { orgId: org };

const reader = testActor('reader', { orgId: org, permissions: [read] }).actor;
const writer = testActor('writer', { orgId: org, permissions: [read, write] }).actor;
const outsider = testActor('outsider', { orgId: otherOrg, permissions: [read, write] }).actor;

unitTest('${feature.camel} read denies anonymous and cross-org actors', async () => {
  await expect(can${feature.pascal}Read).toDenyPolicy({ actor: null, input });
  await expect(can${feature.pascal}Read).toDenyPolicy({ actor: outsider, input });
  await expect(can${feature.pascal}Read).not.toDenyPolicy({ actor: reader, input });
});

unitTest('${feature.camel} write denies the read-only actor', async () => {
  // The outsider holds the grant and is still denied: the predicate is a second, independent
  // gate, and this is the assertion that fails if someone deletes it.
  await expect(can${feature.pascal}Write).toDenyPolicy({ actor: reader, input });
  await expect(can${feature.pascal}Write).toDenyPolicy({ actor: outsider, input });
  await expect(can${feature.pascal}Write).not.toDenyPolicy({ actor: writer, input });
});

unitTest('${feature.camel} rules name the permission they require', () => {
  expect(can${feature.pascal}Read.permissions).toEqual(['${feature.kebab}:read']);
  expect(can${feature.pascal}Write.permissions).toEqual(['${feature.kebab}:write']);
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
