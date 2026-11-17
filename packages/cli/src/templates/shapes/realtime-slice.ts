// `--shape realtime`'s server half: the org's live room (a channel), the read a client re-runs
// after a gap, and the notifier that tells the room a post landed. Each beside its unit test; the
// mutator is `realtime-mutator.ts`, the two-node proof `realtime-nodes.ts`.

import type { GeneratedFile, NameSet } from '../naming';

const SLICE = 'apps/web/app/post';

const channels =
  (): string => `// postActivity: the org's live room. Every member's socket, on whichever \`sync\` node it landed,
// joins \`post-activity.<orgId>\`; an event published once — by \`postCreated\` on a worker — reaches
// all of them through the bus the boot installed (NATS_URL; in-process under \`x dev\`). It carries
// EVENTS only, "a post landed: re-read", never rows: the rows are \`postList\`'s, a live query.
//
// \`catchUp\` is the read a client re-runs after a \`replay-gap\`. Its policy is THIS channel's, the
// same object, or \`channel()\` refuses it (X_CHANNEL_CATCHUP_POLICY_MISMATCH).

import { channel } from '@ultimat3/realtime';
import { canPostWatch } from './policy';
import { recentPosts } from './queries/recent-posts';

export const postActivity = channel('post-activity', {
  params: ['orgId'],
  policy: canPostWatch,
  catchUp: recentPosts,
  events: true,
});
`;

const recentPostsQuery =
  (): string => `// recentPosts: the org's newest posts, for the org the room names — what \`postActivity\`'s client
// re-reads after a gap. Its input IS the channel's params, so its policy is the channel's own rule.
// \`t\` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import type { Post } from '../entity';
import { canPostWatch } from '../policy';
import * as repo from '../repo';

/** A catch-up is a page, never the table: a constant, so no caller picks the read's cost. */
export const RECENT_POSTS = 20;

export const recentPosts = query({
  input: t.object({ orgId: t.uuid }),
  policy: canPostWatch,
  // The refusals a caller may branch on, closed: add each code this read comes to throw.
  errors: [],
  sql: ({ orgId }) =>
    // \`repo.list\`'s order, spelled as SQL: newest first, the id last so the order is total.
    from<Post>('posts', () => repo.list(RECENT_POSTS))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(RECENT_POSTS),
});
`;

const recentPostsTest = (
  app: NameSet,
): string => `// recentPosts, READ: the org the input names is the caller's own, or the read is refused.
import { driver } from '@${app.kebab}/db';
import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from '../repo';
import { RECENT_POSTS, recentPosts } from './recent-posts';

const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';
const target = recentPosts.named('recentPosts');
const member = testActor('member', { orgId, permissions: ['post:read'] }).actor;
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (title: string) => {
  const draft = { orgId, title, price: { minor: 0, currency: 'USD' } };
  return runWithContext(ctxOf({ actor: member, clock }), () => repo.insert(draft));
};

afterEach(() => {
  driver.reset?.();
});

unitTest('another org’s room is refused, even to a member holding the grant', async () => {
  const refused = await target.as(member, { orgId: otherOrg }).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('the org’s posts, newest first, and never more than one page', async () => {
  for (let at = 0; at <= RECENT_POSTS; at += 1) {
    await store(\`post \${String(at)}\`);
    clock.advance(1000);
  }
  const page = await target.as(member, { orgId });
  expect(page.length).toBe(RECENT_POSTS);
  expect(page[0]?.title).toBe(\`post \${String(RECENT_POSTS)}\`);
});
`;

const postCreated =
  (): string => `// postCreated: "a post landed — re-read", told to the org's live room on EVERY sync node. A
// notifier is a job: \`createPost\` enqueues it in its own transaction (a rolled-back create tells
// nobody), a bus that refuses the send is retried, and the delivery ledger makes a replayed run tell
// the room once.
//
// The audience is the ROOM, one bulk delivery: the org is the one recipient. A per-member channel
// — mail, push, the inbox — is one more \`deliver\` entry and a \`recipients\` that names the members.

import { bulkChannel, notifier, t } from '@ultimat3/notify';
import { publishChannelEvent } from '@ultimat3/realtime/server';
import { postActivity } from '../channels';

/** The event every member's tab receives: what happened and to which row — never the row itself. */
export const POST_CREATED = 'post.created';

interface PostCreated {
  readonly id: string;
  readonly orgId: string;
}

export const postCreated = notifier({
  name: POST_CREATED,
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  tenant: (params) => params.orgId,
  // One announcement per post: a retried create, or a replayed run, tells the room once.
  key: (params) => \`post-created:\${params.id}\`,
  recipients: ({ input }) => [{ id: input.orgId }],
  deliver: [
    {
      channel: bulkChannel<PostCreated>('room', ({ event }) =>
        publishChannelEvent(
          postActivity,
          { orgId: event.params.orgId },
          { type: POST_CREATED, id: event.params.id },
        ),
      ),
    },
  ],
});
`;

const postCreatedTest =
  (): string => `// postCreated's declaration: one announcement per post, under the org it names. What it sends,
// and to whom, is the room's test (../channels.test.ts) and the two nodes' (../channels.live.test.ts).
import { expect, unitTest } from '@ultimat3/testing';
import { POST_CREATED, postCreated } from './post-created';

const params = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
};

unitTest('one key per post, and the run acts as the org the post is in', () => {
  expect(postCreated.name).toBe(POST_CREATED);
  expect(postCreated.idempotencyKeyFor({ params })).toBe(\`post-created:\${params.id}\`);
  expect(postCreated.tenantFor({ params })).toBe(params.orgId);
});
`;

/** The room, its catch-up read and the notifier — each with its unit test. */
export const realtimeSliceFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${SLICE}/channels.ts`, contents: channels() },
  { path: `${SLICE}/queries/recent-posts.ts`, contents: recentPostsQuery() },
  { path: `${SLICE}/queries/recent-posts.test.ts`, contents: recentPostsTest(app) },
  { path: `${SLICE}/jobs/post-created.ts`, contents: postCreated() },
  { path: `${SLICE}/jobs/post-created.test.ts`, contents: postCreatedTest() },
];
