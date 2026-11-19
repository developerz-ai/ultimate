// What `x g query` asks of a slice somebody wrote before it plans a file: the table its
// `entity.ts` declares and the rule its `policy.ts` exports. Split from `query.ts` at the ceiling.

import { UltimateError } from '@ultimat3/core';
import { SlicePolicyIncompleteError } from '../generate-slice-policy';
import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { exportsUnknown, sliceExports } from './slice-foundation';

/** The slice modules as they stand on disk; absent is "this run writes the scaffolded one". */
export interface SliceOnDisk extends FeatureTarget {
  readonly sliceEntity?: string;
  readonly slicePolicy?: string;
}

/**
 * The read imports the slice's own row type and repo, and a slice declaring another table under
 * its name — or exporting no such type — has neither.
 */
export class QuerySliceEntityError extends UltimateError {
  constructor(input: { readonly path: string; readonly binding: string; readonly table: string }) {
    super({
      code: 'X_QUERY_SLICE_ENTITY',
      cause: `x g query reads the slice's own scaffolded table, and its entity.ts declares ${input.binding} (${input.table}) instead — the generated read would import a row type and a repo that do not exist`,
      fix: `x queries list --json   # then declare query({ sql: … from('${input.table}', …) }) by hand in ${input.path}, over ../entity's ${input.binding}`,
      meta: { binding: input.binding, table: input.table },
    });
  }
}

/**
 * Refuse a hand-written slice whose `policy.ts` lacks what the read imports from it: the rule and,
 * cached, the tag. Thrown while the files are planned — a dangling VALUE import in a registered
 * module is every later command failing to load the app. The row type is not asked for: a missing
 * `type` is erased at load and is the typecheck's to name, and `X_BOUNDARY_ROUTE_TO_DB`'s printed
 * fix runs this generator into slices whose `entity.ts` an author shaped.
 */
export function assertSliceExports(target: SliceOnDisk, feature: NameSet, live: boolean): void {
  const policy = target.slicePolicy;
  // A barrel re-exporting a module nobody could read: cannot tell, so never refused on a guess.
  if (policy === undefined || exportsUnknown(policy)) return;
  const needed = [`can${feature.pascal}Read`, ...(live ? [] : [`${feature.camel}Tag`])];
  const missing = needed.filter((name) => !sliceExports(policy, name));
  if (missing.length === 0) return;
  throw new SlicePolicyIncompleteError({
    policy: `${target.surfaceDir}/${target.feature}/policy.ts`,
    feature: target.feature,
    missing,
    kind: 'query',
  });
}

/** A foundation test asserts the scaffold's shape: never planted beside a module the author wrote. */
export const withoutOwnedTests = (
  files: readonly GeneratedFile[],
  target: SliceOnDisk,
): readonly GeneratedFile[] =>
  files.filter(
    (file) =>
      !(target.sliceEntity !== undefined && file.path.endsWith('/entity.test.ts')) &&
      !(target.slicePolicy !== undefined && file.path.endsWith('/policy.test.ts')),
  );
