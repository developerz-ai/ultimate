// `importPosts`, the posts slice's `importRows()` job — the inbound twin of `exportPosts`, reading
// the CSV that job writes. One primitive per file, the layout `x g` writes.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package for it.

import { db } from '@postly/db';
import { POST_STATUSES, SLUG_MAX, TITLE_MAX } from '@postly/domain';
import { importRows, t } from '@ultimat3/jobs';
import { disk } from '@ultimat3/storage';

/** Where one import's refused-row report lands: under its org, beside its exports. */
export const postsImportErrorPrefix = ({ orgId, importId }: { orgId: string; importId: string }) =>
  `org/${orgId}/imports/posts/${importId}`;

/**
 * One exported row as it comes back. Every column the export writes is declared, because the
 * header must name exactly `columns`; `likeCount` and the instants are read and then left to the
 * database, since a like is a row in `likes` and not a number a file may restore.
 */
const ImportedPost = t.object({
  id: t.uuid,
  slug: t.string.max(SLUG_MAX),
  title: t.string.max(TITLE_MAX),
  status: t.enumerated(...POST_STATUSES),
  likeCount: t.number.int().min(0),
  publishedAt: t.nullable(t.date),
  createdAt: t.date,
});

/**
 * An org's posts restored from its own export file — `importRows()`, a job factory, because
 * "read the upload and insert it" is the job that holds the whole file and re-inserts from row
 * one on every retry. Each page is one insert-or-ignore: a post already stored under its id is
 * left exactly as it is, so a page handled twice writes nothing the second time.
 *
 * A restored post comes back as a DRAFT with no excerpt or body (the export carries neither):
 * publishing is the publish action's decision, with its mail and its webhook, never a column in a
 * file. `tenant` is the org the input names, so the insert is scoped to it and fails closed for
 * any other.
 */
export const importPosts = importRows({
  name: 'posts.import',
  // The key is the caller's, so it is held to the org the run is scoped to: `tenant` scopes the
  // WRITES, and nothing else stops an import reading another org's upload into this one.
  input: t.object({ orgId: t.uuid, importId: t.uuid, authorId: t.uuid, key: t.string }).refine({
    name: 'key-in-own-org',
    message: 'key must sit under org/<orgId>/imports/ for the orgId this import names',
    check: ({ orgId, key }) => key.startsWith(`org/${orgId}/imports/`) && !key.includes('..'),
    path: ['key'],
  }),
  tenant: ({ orgId }) => orgId,
  // A thunk, read per page: this line runs at import, before boot has built the disk.
  source: () => disk(),
  key: ({ key }) => key,
  format: 'csv',
  columns: ['id', 'slug', 'title', 'status', 'likeCount', 'publishedAt', 'createdAt'],
  schema: ImportedPost,
  handle: ({ rows, input }) =>
    db.posts.upsertAll(
      rows.map((row) => ({
        id: row.id,
        orgId: input.orgId,
        authorId: input.authorId,
        slug: row.slug,
        title: row.title,
        excerpt: '',
        body: '',
      })),
      { onConflict: ['id'], onMatch: 'nothing' },
    ),
  errors: { sink: () => disk(), prefix: postsImportErrorPrefix },
});
