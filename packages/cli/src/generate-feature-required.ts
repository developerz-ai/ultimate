// `x g query`, `backfill`, `export-rows` and `import-rows` read a table, so a slice with no
// `entity.ts` is refused rather than handed one: `x g query order` wrote 14 files and `next: x db
// gen "create orders"`. Only `x g entity` and `x g resource` create a feature's data. And `x g
// action` / `mutator` enforce a permission, so with no slice to write into they are refused rather
// than handed a new subject: only `x g policy` and `x g resource` create one (D13).

import { existsSync } from 'node:fs'; // why: a synchronous file probe, as the slice's own guard.
// why: Bun ships no path helpers; the slice's own directory name is matched against its siblings.
import { basename } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { commentSafe } from './comment-safe';
import { closestSlice, slicesBeside } from './generate-feature';
import type { Generator } from './generate-kinds';
import { containedPath } from './generate-write';
import { quoteArg } from './shell-quote';

/** The generators whose whole body reads a table the slice declares. */
export const READS_A_TABLE: ReadonlySet<Generator> = new Set<Generator>([
  'query',
  'backfill',
  'export-rows',
  'import-rows',
]);

/**
 * The generators whose body enforces `can('<slice>:<verb>')`: in a slice that does not exist the
 * run wrote a `policy.ts` and granted the new subject in `roles.ts` — a permission nobody named.
 */
export const ENFORCES_A_PERMISSION: ReadonlySet<Generator> = new Set<Generator>([
  'action',
  'mutator',
]);

/** Declared beside its one thrower: `errors.ts` sits at its 500-line ceiling. */
export class FeatureRequiredError extends UltimateError {
  constructor(input: { readonly cause: string; readonly fix: string }) {
    super({ code: 'X_FEATURE_REQUIRED', cause: input.cause, fix: input.fix });
  }
}

export interface SliceToRead {
  readonly kind: Generator;
  /** The name as the caller spelled it, for the line the fix reproduces. */
  readonly name: string;
  readonly feature: string | undefined;
  /** `sliceDir(surface, kebab(feature ?? name))`, relative to the app root. */
  readonly slice: string;
  /** `reproducedFlags`' spelling of what the caller set: a fix never loses `--live`. */
  readonly flags: readonly string[];
}

/**
 * Refuses a read with no table to read, for the two kinds whose body needs one. Runs after
 * `assertFeatureExists`, so a `--feature` reaching here names a directory that is there.
 *
 * Named flags stay out of the leading line's `--feature`, which this fix supplies itself.
 */
export function assertSliceToRead(root: string, target: SliceToRead): void {
  assertSliceToWrite(root, target);
  const { kind, name, feature, slice, flags } = target;
  if (!READS_A_TABLE.has(kind)) return;
  if (existsSync(containedPath(root, `${slice}/entity.ts`))) return;
  if (feature !== undefined) {
    throw new FeatureRequiredError({
      cause: `x g ${kind} reads a table, and ${slice} holds no entity.ts — a generator writing into a slice never invents one`,
      fix: `x g entity ${quoteArg(feature)}`,
    });
  }
  const tables = slicesBeside(root, slice).filter((candidate) =>
    existsSync(containedPath(root, `${slice}/../${candidate}/entity.ts`)),
  );
  const near = closestSlice(name, tables);
  const named = quoteArg(name);
  const listed = commentSafe(tables.join(', '));
  throw new FeatureRequiredError({
    cause: `x g ${kind} ${named} names no --feature and ${slice} holds no entity.ts (${tables.length === 0 ? 'no slice holds one yet' : `slices with one: ${listed}`}), and a read never creates the table it reads`,
    fix:
      near !== undefined
        ? `${[`x g ${kind} ${named} --feature ${quoteArg(near)}`, ...flags].join(' ')}   # or x g resource ${named} for a new table`
        : tables.length === 0
          ? `x g resource ${named}   # a new table: x g ${kind} reads one, and none exists yet`
          : `x g resource ${named}   # a new table, or x g ${kind} ${named} --feature <slice> to read one of: ${listed}`,
  });
}

/**
 * Refuses an action or mutator whose name names no slice and no `--feature` names one: the run
 * would invent the permission subject it enforces. A `--feature` was already held to an existing
 * directory by `assertFeatureExists`; a slice of the name's own spelling is today's path.
 */
function assertSliceToWrite(root: string, target: SliceToRead): void {
  const { kind, name, feature, slice, flags } = target;
  if (!ENFORCES_A_PERMISSION.has(kind) || feature !== undefined) return;
  const slices = slicesBeside(root, slice);
  if (slices.includes(basename(slice))) return;
  const near = closestSlice(name, slices);
  const named = quoteArg(name);
  const listed = commentSafe(slices.join(', '));
  throw new FeatureRequiredError({
    cause: `x g ${kind} ${named} names no --feature and ${slice} is no slice (${slices.length === 0 ? 'no slice exists yet' : `slices: ${listed}`}), and an ${kind} never creates the permission subject it enforces — only x g policy and x g resource do`,
    fix:
      near !== undefined
        ? `${[`x g ${kind} ${named} --feature ${quoteArg(near)}`, ...flags].join(' ')}   # or x g policy ${named} for a new permission subject`
        : slices.length === 0
          ? `x g policy ${named}   # a new permission subject: x g ${kind} writes into a slice, and none exists yet`
          : `x g policy ${named}   # a new permission subject, or x g ${kind} ${named} --feature <slice> to write into one of: ${listed}`,
  });
}
