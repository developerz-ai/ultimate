// Single responsibility: `X_SCHEMA_DUMP_DRIFT` — what it means for a committed schema dump to
// disagree with the one the migrations produce, and how each disagreement reads. Pure: files in,
// differences out. Which directory the dump lives in is the caller's fact; paths here are relative.

import { DbError } from './errors';
import type { SchemaDumpFile } from './schema-dump';

export type SchemaDumpDifferenceKind =
  | 'missing-file'
  | 'changed-file'
  | 'unexpected-file'
  | 'unloadable'
  | 'reload-differs';

export interface SchemaDumpDifference {
  readonly kind: SchemaDumpDifferenceKind;
  /** Relative to the dump directory. */
  readonly path: string;
  readonly cause: string;
  readonly fix: string;
}

/** Regenerating is the whole repair for a dump that is merely behind. */
export const SCHEMA_DUMP_FIX = 'x db gen';

/**
 * For a dump that regenerating cannot repair. It still starts with the command, because the first
 * thing to rule out is a dump that is merely stale — and it says what the second failure means,
 * since nothing the app's author can run fixes a statement the dump renders wrong.
 */
const roundTripFix = (path: string): string =>
  `x db gen   # and when the regenerated dump is refused the same way, ${path} holds an object the dump cannot round-trip: report it with that file and the migration that creates it`;

const byPath = (a: SchemaDumpDifference, b: SchemaDumpDifference): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The committed files against the rendered ones, byte for byte, in both directions: a file the
 * migrations produce and nobody committed, one whose bytes differ, and one on disk that nothing
 * renders. The last matters as much as the first — a stray `04_tables/old.sql` is a table an
 * agent reading the directory believes exists.
 */
export function compareSchemaDump(
  committed: readonly SchemaDumpFile[],
  rendered: readonly SchemaDumpFile[],
): readonly SchemaDumpDifference[] {
  const onDisk = new Map(committed.map((file) => [file.path, file.content]));
  const produced = new Set(rendered.map((file) => file.path));
  const differences: SchemaDumpDifference[] = [];
  for (const file of rendered) {
    const held = onDisk.get(file.path);
    if (held === file.content) continue;
    differences.push(
      held === undefined
        ? {
            kind: 'missing-file',
            path: file.path,
            cause: `schema dump file ${file.path} is what the migrations produce and is not committed`,
            fix: SCHEMA_DUMP_FIX,
          }
        : {
            kind: 'changed-file',
            path: file.path,
            cause: `schema dump file ${file.path} differs from what the migrations produce`,
            fix: SCHEMA_DUMP_FIX,
          },
    );
  }
  for (const file of committed) {
    if (produced.has(file.path)) continue;
    differences.push({
      kind: 'unexpected-file',
      path: file.path,
      cause: `schema dump file ${file.path} describes nothing the migrations produce`,
      fix: SCHEMA_DUMP_FIX,
    });
  }
  return differences.sort(byPath);
}

/**
 * Load equals replay, as a comparison: the dump of the migrated database against the dump of a
 * database built by loading that dump. Any difference means the files are not a cache of the
 * migrations but a second, lossy source. One finding, naming the first file that came back
 * different — the rest follow from it.
 *
 * Asked only of a dump that claims to be whole. One that names objects in `unrendered.sql` has
 * already said it is not, and its caller does not ask.
 */
export function reloadDifferences(
  replayed: readonly SchemaDumpFile[],
  reloaded: readonly SchemaDumpFile[],
): readonly SchemaDumpDifference[] {
  const first = compareSchemaDump(reloaded, replayed)[0];
  if (first === undefined) return [];
  return [
    {
      kind: 'reload-differs',
      path: first.path,
      cause: `a database loaded from the schema dump is not the one the migrations build: ${first.path} comes back different`,
      fix: roundTripFix(first.path),
    },
  ];
}

/** A dump file the database refused, with what the database said about it. */
export const unloadableDump = (path: string, detail: string): SchemaDumpDifference => ({
  kind: 'unloadable',
  path,
  cause: `schema dump file ${path} does not load: ${detail}`,
  fix: roundTripFix(path),
});

export const schemaDumpDrift = (difference: SchemaDumpDifference): DbError =>
  new DbError({
    code: 'X_SCHEMA_DUMP_DRIFT',
    cause: difference.cause,
    fix: difference.fix,
    meta: { kind: difference.kind, path: difference.path },
  });

const DIFFERENCE_KINDS: readonly string[] = [
  'missing-file',
  'changed-file',
  'unexpected-file',
  'unloadable',
  'reload-differs',
] satisfies readonly SchemaDumpDifferenceKind[];

/**
 * The difference a thrown `X_SCHEMA_DUMP_DRIFT` was built from, or `undefined` for anything else.
 * `loadSchemaDump` throws; a caller that reports findings wants the value back, and reading it
 * off the error here keeps `meta`'s shape a fact of this file alone.
 */
export function schemaDumpDifferenceOf(error: unknown): SchemaDumpDifference | undefined {
  if (!(error instanceof DbError) || error.code !== 'X_SCHEMA_DUMP_DRIFT') return undefined;
  const kind = error.meta?.['kind'];
  const path = error.meta?.['path'];
  if (typeof kind !== 'string' || typeof path !== 'string') return undefined;
  if (!DIFFERENCE_KINDS.includes(kind)) return undefined;
  return { kind: kind as SchemaDumpDifferenceKind, path, cause: error.cause, fix: error.fix };
}
