// `x g resource <name> --admin` — the per-entity admin override. `defineAdmin()` already serves
// list/detail/create/edit for the entity with nothing written; this file is only what an app
// author would otherwise hand-write on top — the list columns, a page size, and from there scopes,
// a row scope and computed columns. `admin-registration.ts` lists it under `resources:` in the
// app's `defineAdmin()` call in the same run, so nothing is left to wire.

import type { FeatureTarget } from './entity';
import { entityFiles } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { wrapList } from './wrap';

/** `    title: text({ max: 200 }),` — one column of the entity this same run writes. */
const COLUMN_LINE = /^ {4}([A-Za-z_$][\w$]*): [A-Za-z_$][\w$]*\(.*$/gm;
const TENANT = /^\s*tenant: '([^']+)'/m;

/**
 * The list columns, read off the ENTITY the generator writes for this name — never a second list
 * typed here. It used to be `['id', 'title', 'createdAt']`, which named whatever the entity
 * template held on the day it was written: a column renamed there became
 * `X_ADMIN_FIELD_UNSUPPORTED` on the first request to an app that had just been generated.
 *
 * The key and the tenant column are left out: the list's first column already links the row by
 * its id, and every row an operator sees carries the same tenant.
 */
export function adminListFields(rawName: string, target: FeatureTarget): readonly string[] {
  const source = String(
    entityFiles(rawName, target).find((file) => file.path.endsWith('/entity.ts'))?.contents ?? '',
  );
  const tenant = TENANT.exec(source)?.[1];
  return [...source.matchAll(COLUMN_LINE)]
    .filter((line) => !line[0].includes('.primaryKey()') && line[1] !== tenant)
    .map((line) => line[1] ?? '');
}

const resourceSource = (
  feature: NameSet,
  listFields: readonly string[],
): string => `// Admin override for ${feature.pluralKebab}. The admin already serves /admin/${feature.table} with nothing written
// here — its fields, filters, operations and forms are derived from the entity. This file is what
// the entity cannot say, listed under \`resources: { ${feature.table}: … }\` in the app's defineAdmin().

import type { AdminResourceOptions, AdminRow } from '@ultimat3/admin';

export const ${feature.camel}AdminResource: AdminResourceOptions<AdminRow> = {
  // Columns of the entity, in its own order. A name that is not one is X_ADMIN_FIELD_UNSUPPORTED
  // at boot — delete the line to let the admin pick them.
${wrapList(
  '  ',
  'listFields: [',
  listFields.map((field) => `'${field}'`),
  '],',
)}
  pageSize: 25,
};
`;

const resourceTest = (
  feature: NameSet,
): string => `// The ${feature.kebab} admin override says what the entity cannot derive: the list columns and a
// bounded page size. The columns it lists must BE columns — a name that is not one is
// X_ADMIN_FIELD_UNSUPPORTED on the first request.
import { expect, unitTest } from '@ultimat3/testing';
import { ${feature.camel} } from '../entity';
import { ${feature.camel}AdminResource } from './resource';

const resource = ${feature.camel}AdminResource;

unitTest('${feature.camel}AdminResource sets a bounded page size', () => {
  expect(resource.pageSize).toBeGreaterThan(0);
});

unitTest('every list field is a column of the ${feature.camel} entity', () => {
  const columns = Object.keys(${feature.camel}.$columns);
  expect(resource.listFields?.length).toBeGreaterThan(0);
  for (const field of resource.listFields ?? []) expect(columns).toContain(field);
});
`;

export function adminFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const feature = names(rawName.length > 0 ? rawName : target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/admin`;
  return [
    {
      path: `${dir}/resource.ts`,
      contents: resourceSource(feature, adminListFields(rawName, target)),
    },
    { path: `${dir}/resource.test.ts`, contents: resourceTest(feature) },
  ];
}
