// `x g <kind> --feature <f>` writes INTO a slice, and a slice that does not exist is refused rather
// than invented. It was invented: `x g task nightly --feature reports` laid down an
// `entity('reports', { title, price })` nobody asked for, and the `drift` step then demanded a
// migration for the table. Only `x g entity` and `x g resource` create a feature's data.

import { existsSync } from 'node:fs'; // why: a synchronous directory probe; Bun.file answers files, not directories.
import { UltimateError } from '@ultimat3/core';
import type { Generator } from './generate-kinds';
import { containedPath } from './generate-write';
import { quoteArg } from './shell-quote';

/** The generators whose `--feature` names an existing slice to write into. */
const WRITES_INTO_SLICE: ReadonlySet<Generator> = new Set<Generator>([
  'action',
  'mutator',
  'query',
  'job',
  'task',
]);

/** Declared beside its one thrower: `errors.ts` sits at its 500-line ceiling. */
export class FeatureUnknownError extends UltimateError {
  constructor(input: { readonly feature: string; readonly slice: string }) {
    super({
      code: 'X_FEATURE_UNKNOWN',
      cause: `--feature ${quoteArg(input.feature)} names ${input.slice}, which does not exist — a generator writing into a slice never invents one, or its entity table`,
      fix: `x g resource ${quoteArg(input.feature)}`,
    });
  }
}

/** Refuses a `--feature` whose slice directory is absent, for the kinds that write into one. */
export function assertFeatureExists(
  root: string,
  kind: Generator,
  feature: string | undefined,
  slice: string,
): void {
  if (feature === undefined || !WRITES_INTO_SLICE.has(kind)) return;
  if (existsSync(containedPath(root, slice))) return;
  throw new FeatureUnknownError({ feature, slice });
}
