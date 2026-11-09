// What a shape IS: an overlay over the one scaffold `x new` already writes — files it leaves out,
// catalog keys it drops, in-place edits, and files it adds. Never a second scaffold, so every fix to
// the default reaches every shape on the next release.

import { assert } from '@ultimat3/core';
import type { GeneratedFile, NameSet } from '../naming';

/** One in-place edit of a scaffold file: `find` must occur exactly once, or the overlay is stale. */
export interface ShapeEdit {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
}

export interface ShapeOverlay {
  /** Which scaffold it starts from: `true` is the one with the example `post` slice. */
  readonly example: boolean;
  /** Path prefixes of the base scaffold this shape leaves out. */
  readonly drop: readonly string[];
  /** Dotted catalog keys (a whole subtree each) the dropped files were the only readers of. */
  readonly dropKeys: readonly string[];
  readonly edits: (app: NameSet) => readonly ShapeEdit[];
  /** Added; a path the base already holds is REPLACED, never merged (catalogs merge as JSON). */
  readonly files: (app: NameSet) => readonly GeneratedFile[];
  /**
   * `x g` argv run in the written app, in order, after these files land (`new-shapes-generate.ts`):
   * a capability a generator owns arrives through it, never re-spelled here. Absent: none.
   */
  readonly generate?: readonly (readonly string[])[];
}

const CATALOG = 'packages/i18n/catalogs/en.json';

/** A stale overlay is the framework's bug, never the app's: the shape tests name which one. */
const FIX = 'bun test packages/cli/src/templates/shapes';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The catalog with each dotted key's subtree removed, re-serialised the way `catalogJson` does. */
export function dropCatalogKeys(contents: string, keys: readonly string[]): string {
  const catalog: unknown = JSON.parse(contents);
  assert(isRecord(catalog), `${CATALOG} is not a JSON object`, FIX);
  for (const key of keys) {
    const segments = key.split('.');
    const leaf = segments.pop() ?? '';
    let node: unknown = catalog;
    for (const segment of segments) node = isRecord(node) ? node[segment] : undefined;
    assert(
      isRecord(node) && Object.hasOwn(node, leaf),
      `a shape drops catalog key ${key}, which the base scaffold no longer writes`,
      FIX,
    );
    delete node[leaf];
  }
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** `edit` applied to `contents`; an edit whose anchor moved is refused rather than skipped. */
export function applyEdit(contents: string, edit: ShapeEdit): string {
  const at = contents.indexOf(edit.find);
  assert(
    at !== -1 && contents.indexOf(edit.find, at + 1) === -1,
    `a shape edits ${edit.path} at an anchor that is missing or not unique`,
    FIX,
  );
  return contents.slice(0, at) + edit.replace + contents.slice(at + edit.find.length);
}

const dropped = (overlay: ShapeOverlay, path: string): boolean =>
  overlay.drop.some((prefix) => path === prefix || path.startsWith(prefix));

/** The base scaffold with `overlay` applied, in the base's order, added files last. */
export function applyOverlay(
  base: readonly GeneratedFile[],
  overlay: ShapeOverlay,
  app: NameSet,
): readonly GeneratedFile[] {
  const added = overlay.files(app);
  const replaced = new Set(added.filter((file) => file.merge !== 'json').map((file) => file.path));
  const edits = overlay.edits(app);
  const kept = base
    .filter((file) => !dropped(overlay, file.path) && !replaced.has(file.path))
    .map((file): GeneratedFile => {
      const own = edits.filter((edit) => edit.path === file.path);
      if (file.path === CATALOG && file.merge === 'json') {
        return { ...file, contents: dropCatalogKeys(file.contents, overlay.dropKeys) };
      }
      if (own.length === 0 || typeof file.contents !== 'string') return file;
      return { ...file, contents: own.reduce(applyEdit, file.contents) };
    });
  const unapplied = edits.filter((edit) => !kept.some((file) => file.path === edit.path));
  assert(
    unapplied.length === 0,
    `a shape edits ${unapplied.map((edit) => edit.path).join(', ')}, which the base scaffold does not write`,
    FIX,
  );
  return [...kept, ...added];
}
