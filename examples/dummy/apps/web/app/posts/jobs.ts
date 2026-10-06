/**
 * Work that must outlive the request that caused it. `publishPost` enqueues this in the same
 * transaction as the publish, so a rolled-back publish never mails anybody and a committed one
 * always does.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { exportRows, job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { disk } from '@ultimat3/storage';
import { postPublished } from './mail';
import { exportSource } from './repo';

export const notifySubscribers = job({
  /**
   * `orgId` rides beside the post id, and it is not redundant with it: `posts`, `members` and
   * `comments` are tenant-scoped, so the first read — `ctx.posts.byId` — is already scoped by the
   * acting actor's org, and a job's actor gets one only from `tenant` below. Reading the org OFF
   * the post to declare it is circular. One org's fanout, so the org belongs in the payload; the
   * escape hatch (`tenant: 'none'` plus `crossTenant`) is for a sweep that genuinely spans orgs.
   */
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  /** The post alone: one notification per published post, whichever org it belongs to. */
  idempotencyKey: ({ postId }) => `notify:${postId}`,
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 5, backoff: 'exponential' },
  queue: 'mail',
  /** One fanout in flight at a time; a retry cannot race its own first attempt. */
  concurrency: 1,
  async run({ input, step, ctx }) {
    const post = await step.run('load-post', () => ctx.posts.byId(toPostId(input.postId)));

    // No channel announcement here, and it is a gap rather than a decision: a `ChannelHub` is
    // built by the process that serves sockets (`new ChannelHub(...)` in
    // packages/cli/src/role-sync.ts) and there is no seam by which an app reaches it — a worker
    // building its own would publish onto a transport nothing bridges. This step used to call
    // `ctx.channel(...)`, a service nothing registered, so every run of this job dead-lettered on
    // a `TypeError` before it mailed anybody. The feed stays live through `live.ts`'s
    // `query({ live: true })`, which is the path that does work.
    const recipients = await step.run('load-recipients', () =>
      ctx.orgs.digestRecipients(toOrgId(post.orgId)),
    );

    // The org's NAME, because the mail's `{org}` is a name slot. Its own step, so a provider blip
    // on the send below replays neither this read nor the two above it.
    const org = await step.run('load-org', () => ctx.orgs.byId(toOrgId(post.orgId)));

    for (const member of recipients) {
      // One step per recipient, because the step IS the retry unit: a provider blip on recipient
      // 40 of 50 re-sends recipient 40 and replays the other 39 from storage in microseconds. One
      // step around the whole loop re-sent all 50, which is a mailbox full of duplicates for one
      // transient 503. The member's id names the step because the id survives a replay — a loop
      // index does not, and a step name is the replay key (X_STEP_DUPLICATE).
      await step.run(`send:${member.id}`, () =>
        send(
          postPublished,
          { post, member, org: org.name },
          { to: member.email, locale: member.locale },
        ),
      );
    }
  },
});

/** Where one export's parts and manifest land: under its org, so a key names its tenant. */
export const postsExportPrefix = ({ orgId, exportId }: { orgId: string; exportId: string }) =>
  `org/${orgId}/exports/posts/${exportId}`;

/**
 * Every post an org has written, as CSV parts plus a manifest on the app's disk — `exportRows()`,
 * a job factory, because "all rows to a file" is the job that OOM-kills a pod at two million rows
 * when written as one read and one put. `requestPostsExport` (`./actions.ts`) enqueues it.
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
