// `x g resource <name> --admin` — the per-entity half of the admin screen. `defineAdmin()` derives
// list/detail/create/edit from the entity itself; this file is only the override an app author
// would otherwise hand-write — title, list columns, page size. Wiring it in is one line in
// `apps/admin/src/index.ts` (`entities: [..., ${feature}]`, `resources: { ${feature}: ... }`),
// the same "define once, register once" shape as `packages/db/src/schema.ts`.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const resourceSource = (
  feature: NameSet,
): string => `// Admin override for ${feature.pluralKebab}. Everything not set here — fields, operations,
// detail layout — is derived from the entity. Wire this in once:
//   import { ${feature.camel}AdminResource } from '${'@'}app/web/app/${feature.kebab}/admin/resource';
//   defineAdmin({ entities: [..., ${feature.camel}], resources: { ${feature.table}: ${feature.camel}AdminResource } })

import type { AdminResourceOptions, AdminRow } from '@ultimat3/admin';

export const ${feature.camel}AdminResource: AdminResourceOptions<AdminRow> = {
  titleKey: 'admin.${feature.kebab}.title',
  listFields: ['id', 'title', 'createdAt'],
  pageSize: 25,
};
`;

const resourceTest = (
  feature: NameSet,
): string => `// The ${feature.kebab} admin override says what the entity cannot derive: a title key, the list
// columns, a bounded page size. Everything unset here is derived, and needs no test.
import { expect, unitTest } from '@ultimat3/testing';
import { ${feature.camel}AdminResource } from './resource';

unitTest('${feature.camel}AdminResource sets a title key and bounded list fields', () => {
  expect(${feature.camel}AdminResource.titleKey).toBe('admin.${feature.kebab}.title');
  expect(${feature.camel}AdminResource.listFields?.length).toBeGreaterThan(0);
  expect(${feature.camel}AdminResource.pageSize).toBeGreaterThan(0);
});
`;

export function adminFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const feature = names(rawName.length > 0 ? rawName : target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/admin`;
  return [
    { path: `${dir}/resource.ts`, contents: resourceSource(feature) },
    { path: `${dir}/resource.test.ts`, contents: resourceTest(feature) },
  ];
}
