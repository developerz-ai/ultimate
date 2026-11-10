// Single responsibility: one page of the local disk's listing — every object key under a prefix,
// the `.meta/` sidecar tree kept out of the namespace, ordered, cut at the cursor, and a refused
// scan reported rather than read as an empty disk (`sweepOrphans` trusts this listing).

import { type Page, pageOf, renderFixShellArg } from '@ultimat3/core';
import type { StorageListEntry } from './driver';
import { isMissingFile } from './driver-local-remove';
import { listFailed } from './errors';
import { META_DIR } from './path';

export interface LocalListInput {
  readonly root: string;
  readonly prefix: string;
  /** The last key of the previous page; keys at or before it are skipped. */
  readonly cursor: string | undefined;
  /** A positive integer, already resolved by `resolveListLimit`. */
  readonly limit: number;
  /** Each key's listing view; `undefined` drops a key that went away mid-page. */
  readonly head: (key: string) => Promise<StorageListEntry | undefined>;
}

export async function listLocalPage(input: LocalListInput): Promise<Page<StorageListEntry>> {
  const { root, prefix, cursor, limit } = input;
  const keys: string[] = [];
  try {
    // `dot: true`, and it is load-bearing: without it a glob matches no dot-prefixed entry, so
    // every object whose key has one — `.hidden.txt`, `org/o1/pending/.x.png`, the
    // `.metadata/a.json` `path.test.ts` pins as legal — was absent from the listing while
    // `put`/`get`/`exists` handled it normally and the s3 listing returned it. `sweepOrphans`
    // pages through `list()`, so those objects were swept as if they did not exist: a false
    // erasure report by omission, which is what the classification below exists to prevent.
    for await (const entry of new Bun.Glob('**/*').scan({
      cwd: root,
      onlyFiles: true,
      dot: true,
    })) {
      const key = entry.replaceAll('\\', '/');
      // The real filter now, not a second line of defence: the glob above yields the sidecar
      // tree, and this is the one thing keeping `.meta/<key>.json` out of the object
      // namespace. Folded like `assertSafeKey`'s reservation — `.META/` and `.meta/` are one
      // directory on APFS and NTFS, and listing a key `get()` would refuse is the worse half.
      if (key.toLowerCase().startsWith(`${META_DIR}/`)) continue;
      if (!key.startsWith(prefix)) continue;
      // The cursor IS the last key of the previous page — lexicographic order keeps it stable.
      if (cursor !== undefined && key <= cursor) continue;
      keys.push(key);
    }
  } catch (error) {
    // A disk nobody has written to yet has no directory: an empty listing, not an error.
    if (isMissingFile(error)) return pageOf([], null);
    // Everything else is a refusal, and a bare `catch` reported all of them as "this disk is
    // empty" — `EACCES` on the root, `ENOTDIR` on a root that is a file, an I/O error on the
    // mount. `sweepOrphans` walks `list()`, so that swallow certified an unreadable prefix as
    // having no orphans: the same false report `delete()`'s `.catch(() => undefined)` used to
    // make, one call to the left.
    throw listFailed(
      'local',
      prefix,
      error,
      `ls -ld ${renderFixShellArg(root, "'<the disk root>'")}   # make the disk root readable by this process, then retry`,
    );
  }
  keys.sort();
  const page = keys.slice(0, limit);
  const objects: StorageListEntry[] = [];
  for (const key of page) {
    const object = await input.head(key);
    if (object !== undefined) objects.push(object);
  }
  // The cursor is minted only when a key PAST the page exists — `keys` is every match, so a
  // full last page answers no cursor. `limit` is a positive integer, so a page with more after
  // it always HAS a last key: the `?? null` is the type's, not a second condition. It used to
  // be one, and `limit: 0` fell through it — an empty page reported as complete.
  return pageOf(objects, keys.length > page.length ? (page.at(-1) ?? null) : null);
}
