// `x g resource`'s service module and its test: business logic over the slice's repo, covered
// against the in-memory driver. Split from `resource.ts`, which composes the slice — this file
// owns the one module in it that holds a rule.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';

const serviceSource = (
  feature: NameSet,
): string => `// Business logic for ${feature.pluralKebab}. Knows nothing about HTTP or requests, so a job and an
// action can both call it. Takes values, not a request.

import type { ${feature.pascal} } from './entity';
import { ${feature.pascal}NotFoundError } from './errors';
import * as repo from './repo';

/** Derived from the row, never restated: a new column reaches this input without an edit here. */
export type Create${feature.pascal}Input = Omit<${feature.pascal}, 'id' | 'createdAt'>;

/** The row, aliased once, so every signature below reads at one width whatever the feature is
 * called — a generated file the app's own formatter rewrites is a red \`lint\` over code nobody
 * typed. */
type Row = ${feature.pascal};

export async function create(input: Create${feature.pascal}Input): Promise<Row> {
  return repo.insert(input);
}

export async function require${feature.pascal}(id: string): Promise<Row> {
  const row = await repo.byId(id);
  if (row === undefined) throw new ${feature.pascal}NotFoundError({ id });
  return row;
}
`;

/** The feature's own code, spelled once: the class throws it and the test matches on it. */
const notFoundCode = (feature: NameSet): string =>
  `X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND`;

const serviceTest = (
  feature: NameSet,
  dbModule: string,
): string => `// The ${feature.kebab} service against the in-memory driver, and its failure, pinned: a code an
// agent can match on, a cause naming the row, and a fix that is an instruction.
${sortedImports([
  "import { ctxOf, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { afterEach, expect, unitTest } from '@ultimat3/testing';",
  `import { driver } from '${dbModule}';`,
])}
import { ${feature.pascal}NotFoundError } from './errors';
import { create, require${feature.pascal} } from './service';

const orgId = '00000000-0000-4000-8000-000000000002';
const absent = '00000000-0000-4000-8000-0000000000ff';
const draft = { orgId, title: 'First', price: { minor: 1200, currency: 'USD' } };

/** What a request is to the repo underneath: an actor, whose org every statement runs under. */
const inOrg = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: testActor('member', { orgId }).actor }), run);

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('${feature.pascal}NotFoundError carries a code, a cause and a fix', () => {
  const error = new ${feature.pascal}NotFoundError({ id: 'missing' });
  expect(error).toBeUltimateError('${notFoundCode(feature)}');
  expect(error.cause).toContain('missing');
  expect(error.fix.length).toBeGreaterThan(0);
});

unitTest('create stores the row and the lookup answers it', async () => {
  const created = await inOrg(() => create(draft));
  expect(created.title).toBe('First');
  // \`toEqualRow\`, never \`toEqual\`: a \`.sealed()\` column is a non-enumerable property of a row.
  expect(await inOrg(() => require${feature.pascal}(created.id))).toEqualRow(created);
});

unitTest('the lookup refuses an id nothing holds', async () => {
  const lookup = inOrg(() => require${feature.pascal}(absent));
  const refused = await lookup.catch((error: unknown) => error);
  expect(refused).toBeUltimateError('${notFoundCode(feature)}');
});
`;

/** `service.ts` and the test that covers it. `dbModule` is where the test resets the driver. */
export const serviceFiles = (
  feature: NameSet,
  dir: string,
  dbModule: string,
): readonly GeneratedFile[] => [
  { path: `${dir}/service.ts`, contents: serviceSource(feature) },
  { path: `${dir}/service.test.ts`, contents: serviceTest(feature, dbModule) },
];
