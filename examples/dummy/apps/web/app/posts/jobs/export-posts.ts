// `exportPosts`, the posts slice's `exportRows()` job — one primitive per file, the layout `x g` writes.
//
// Work that must outlive the request that caused it. `publishPost` enqueues this in the same
// transaction as the publish, so a rolled-back publish never mails anybody and a committed one
// always does.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { orgId as toOrgId } from '@postly/domain';
import { exportRows, t } from '@ultimat3/jobs';
import { disk } from '@ultimat3/storage';
import { exportSource } from '../repo';

/** Where one export's parts and manifest land: under its org, so a key names its tenant. */
export const postsExportPrefix = ({ orgId, exportId }: { orgId: string; exportId: string }) =>
  `org/${orgId}/exports/posts/${exportId}`;

/**
 * Every post an org has written, as CSV parts plus a manifest on the app's disk — `exportRows()`,
 * a job factory, because "all rows to a file" is the job that OOM-kills a pod at two million rows
 * when written as one read and one put. `requestPostsExport` (`../actions/request-posts-export.ts`) enqueues it.
 *
 * `tenant` is the security boundary of the whole feature: an export concentrates one org's posts
 * into one downloadable object, and the source read runs scoped to that org. Instants leave as ISO
 * 8601 UTC — machine data for a spreadsheet or an import, never a date formatted for a reader.
 */
export const exportPosts = exportRows({
  name: 'posts.export',
  input: t.object({ orgId: t.uuid, exportId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  prefix: postsExportPrefix,
  source: ({ input }) => exportSource(toOrgId(input.orgId)),
  format: 'csv',
  columns: ['id', 'slug', 'title', 'status', 'likeCount', 'publishedAt', 'createdAt'],
  row: (post) => ({
    id: post.id,
    slug: post.slug,
    title: post.title,
    status: post.status,
    likeCount: post.likeCount,
    publishedAt: post.publishedAt === null ? null : post.publishedAt.toISOString(),
    createdAt: post.createdAt.toISOString(),
  }),
  // A thunk, read per write: this line runs at import, before boot has built the disk.
  sink: () => disk(),
});
