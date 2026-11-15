// What `x g export-rows` and `x g import-rows` share: both move the slice's OWN scaffolded table
// (`db.<plural>`, its `title` and `price`) through storage, so a slice whose entity is shaped
// otherwise is refused before a file is planned, and the test helpers are spelled once.

import { stripComments, UltimateError } from '@ultimat3/core';
import type { FeatureTarget } from './entity';
import { sortedImports } from './imports';
import type { NameSet } from './naming';
import { sliceTakesScaffoldRow } from './slice-foundation';
import { wrapImport } from './wrap';

/** The slice's files as `x g` read them off the disk: absent when the feature has none yet. */
export interface RowsOptions extends FeatureTarget {
  readonly locales?: readonly string[];
  readonly sliceEntity?: string;
  readonly sliceRepo?: string;
}

/** Declared beside its two throwers' shared check: `errors.ts` sits at its ceiling. */
export class RowsSliceEntityError extends UltimateError {
  constructor(input: {
    readonly kind: string;
    readonly name: string;
    readonly feature: string;
    readonly tables: readonly string[];
  }) {
    const declared = input.tables.length === 0 ? 'no table' : input.tables.join(', ');
    super({
      code: 'X_ROWS_SLICE_ENTITY',
      cause: `x g ${input.kind} moves the ${input.feature} slice's own scaffolded table, and its entity.ts declares ${declared} instead — the generated columns would name fields that table does not have`,
      fix: `x g job ${input.name} --feature ${input.feature}   # then declare ${input.kind === 'export-rows' ? 'exportRows' : 'importRows'}({ … }) from @ultimat3/jobs in it over db.<one of: ${declared}>`,
      meta: { feature: input.feature, tables: [...input.tables] },
    });
  }
}

/** Every table an `entity.ts` declares, in source order. */
const declaredTables = (source: string): readonly string[] =>
  [...stripComments(source).matchAll(/\bentity\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );

/** Refuses a slice whose entity is not the scaffolded row; a slice with none gets it planted. */
export function assertScaffoldRow(kind: string, name: NameSet, target: RowsOptions): void {
  if (target.sliceEntity === undefined) return;
  if (sliceTakesScaffoldRow(target, target.sliceEntity, target.sliceRepo)) return;
  throw new RowsSliceEntityError({
    kind,
    name: name.kebab,
    feature: target.feature,
    tables: declaredTables(target.sliceEntity),
  });
}

/** The unit suite's head: two orgs, a memory disk installed per test, both torn down after. */
export const rowsTestHead = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
  bindings: readonly string[] = [name.camel],
): string => `${sortedImports([
  "import { ctxOf, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';",
  "import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';",
  `import { db, driver } from '${dbModule}';`,
])}
import type { ${feature.pascal} } from '../entity';
${wrapImport(bindings, `./${name.kebab}`)}

const orgA = '00000000-0000-4000-8000-000000000002';
const orgB = '00000000-0000-4000-8000-000000000009';

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: testActor('member', { orgId }).actor }), run);

const store = (orgId: string, title: string): Promise<${feature.pascal}> => {
  const draft = { orgId, title, price: { minor: 1250, currency: 'USD' } };
  return inOrg(orgId, () => db.${feature.plural}.insert(draft));
};

// A memory disk per test, installed as the app's storage: the job resolves \`disk()\` per page.
let disk = memoryStorageDriver();
beforeEach(() => {
  disk = memoryStorageDriver();
  defineStorage({ disks: { local: disk } });
});

// One store per process: without this, one test's rows and objects are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
  resetStorage();
});
`;
