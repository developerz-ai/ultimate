// `purgeImports`, the posts slice's `purge()` job — one primitive per file, the layout `x g` writes.
//
// An import's uploaded file outlives its import only as long as a re-run needs it; an upload a phone
// abandoned halfway outlives nothing, but its parts bill until something aborts them. Bucket rules
// are the operator's and a local disk has none, so this sweep is the app's, on every disk.

import { purge } from '@ultimat3/jobs';
import { disk, objectPurgeTarget } from '@ultimat3/storage';
import { isPostsImportKey } from '../import-upload';

/** A week: long enough to re-run a failed import from the file, short enough not to keep it. */
export const POSTS_IMPORT_RETENTION_MS = 7 * 24 * 3_600_000;

/**
 * Every org's `imports/posts/` files and open sessions past the window. The prefix is `org/` and
 * `match` narrows it: one kind of file under every tenant is a pattern no single prefix spells, and
 * the avatars beside it must never meet this window. `runs/tasks/hourly-retention.ts` fires it.
 */
export const purgeImports = purge({
  name: 'posts.imports.purge',
  // Read per attempt: this line runs at import, before boot has built the disk.
  targets: () => [
    objectPurgeTarget({
      name: 'posts.imports',
      disk: disk(),
      prefix: 'org/',
      match: isPostsImportKey,
      olderThanMs: POSTS_IMPORT_RETENTION_MS,
    }),
  ],
});
