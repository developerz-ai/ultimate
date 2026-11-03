// `x g <kind> --feature <f>` writes INTO a slice, and a slice that does not exist is refused rather
// than invented. It was invented: `x g task nightly --feature reports` laid down an
// `entity('reports', { title, price })` nobody asked for, and the `drift` step then demanded a
// migration for the table. Only `x g entity` and `x g resource` create a feature's data.

import { existsSync, readdirSync } from 'node:fs'; // why: a synchronous directory probe and listing; Bun.file answers files, not directories.
// why: Bun ships no path helpers.
import { dirname, join } from 'node:path';
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
  'backfill',
]);

/** What makes a directory a slice rather than a page: a page directory holds a route and no module. */
const SLICE_MEMBERS = [
  'entity.ts',
  'policy.ts',
  'repo.ts',
  'service.ts',
  'actions',
  'queries',
  'jobs',
  'tasks',
  'live',
];

/** How far a `--feature` may be from a slice and still read as a typo of it. */
const NEAR_DISTANCE = 2;

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const swap = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, swap);
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
};

/** The nearest slice within `NEAR_DISTANCE`, first in the given order on a tie. */
export function closestSlice(feature: string, slices: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = NEAR_DISTANCE + 1;
  for (const slice of slices) {
    const distance = editDistance(feature, slice);
    if (distance < bestDistance) {
      best = slice;
      bestDistance = distance;
    }
  }
  return best;
}

/** The surface's slices, sorted. A surface with no directory yet has none. */
export const slicesBeside = (root: string, slice: string): readonly string[] => {
  const surface = containedPath(root, dirname(slice));
  if (!existsSync(surface)) return [];
  return readdirSync(surface, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => SLICE_MEMBERS.some((member) => existsSync(join(surface, name, member))))
    .sort();
};

export interface FeatureUnknownInput {
  readonly kind: Generator;
  readonly name: string;
  readonly feature: string;
  readonly slice: string;
  readonly slices: readonly string[];
}

/**
 * Declared beside its one thrower: `errors.ts` sits at its 500-line ceiling.
 *
 * Near a real slice, the fix is the command the author meant. `x g resource <typo>` first is how a
 * typo became a table. It stays the fix when nothing is near, with the slices in the cause.
 */
export class FeatureUnknownError extends UltimateError {
  constructor(input: FeatureUnknownInput) {
    const near = closestSlice(input.feature, input.slices);
    const existing =
      input.slices.length === 0 ? 'no slice exists yet' : `slices: ${input.slices.join(', ')}`;
    super({
      code: 'X_FEATURE_UNKNOWN',
      cause: `--feature ${quoteArg(input.feature)} names ${input.slice}, which does not exist (${existing}) — a generator writing into a slice never invents one, or its entity table`,
      fix:
        near === undefined
          ? `x g resource ${quoteArg(input.feature)}`
          : `x g ${quoteArg(input.kind)} ${quoteArg(input.name)} --feature ${quoteArg(near)}`,
    });
  }
}

/** Refuses a `--feature` whose slice directory is absent, for the kinds that write into one. */
export function assertFeatureExists(
  root: string,
  kind: Generator,
  feature: string | undefined,
  slice: string,
  name: string,
): void {
  if (feature === undefined || !WRITES_INTO_SLICE.has(kind)) return;
  if (existsSync(containedPath(root, slice))) return;
  throw new FeatureUnknownError({ kind, name, feature, slice, slices: slicesBeside(root, slice) });
}
