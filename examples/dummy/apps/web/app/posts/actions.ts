/**
 * The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
 * same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 * `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
 * each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
 * belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.
 */

import { COMMENT_MAX, tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { agent, hive, llm } from '@ultimat3/ai';
import { CommentView, CreatePostInput, PostView } from './entity';
import { exportPosts, notifySubscribers, postsExportPrefix } from './jobs';
import { commentPosted } from './notifiers';
import { postCreate, postExport, postPublish, postRead } from './policy';
import { reviewDraftPrompt } from './prompts/review-draft';
import { summarizePrompt } from './prompts/summarize';

export const createPost = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database. A predicate that fetched a row would cost one query per live subscriber.
  input: CreatePostInput.extend({ orgId: t.uuid }),
  output: PostView,
  policy: postCreate,
  cache: { invalidates: [tag.feed] },
  mcp: { expose: true, description: 'Create a draft post in the actor’s organisation' },
  async handle({ input, ctx }) {
    return ctx.posts.createDraft(input);
  },
});

export const publishPost = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: postPublish,
  // `postPublish` decides about a post, not just about an org, so the post has to be loaded
  // before the guard rather than inside it — the predicate stays synchronous, and this runs once
  // per invocation instead of once per live subscriber.
  //
  // The loader runs BEFORE any policy, which is the ordering that decides the scope: the service
  // reads inside the ACTING member's org and answers `null` for anyone without one, so a foreign
  // caller reaches the rule with `row: null` and is denied. Scoping it to `input.orgId` instead
  // put a tenancy error (`X_TENANCY_ACTOR_MISMATCH`, or `X_TENANCY_ACTOR_ORG_REQUIRED` for an
  // anonymous caller) in front of the denial — an unscoped read is `X_TENANCY_UNSCOPED`, and
  // neither is the `X_FORBIDDEN` this action's contract promises.
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  // `blog` too: publishing is the ONE write that puts a post on the public, anonymous blog, and
  // `site/blog/*` sets `revalidate: { tags: [tag.blog] }`. Omitting it left those ISR pages
  // pinned to whatever the build saw — the tag existed, nothing ever evicted it.
  cache: { invalidates: [tag.post, tag.feed, tag.blog] },
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(postId(input.postId));
    // The job enqueues itself through its own handle, in the same transaction as the publish: a
    // rolled-back publish never mails anybody and a committed one always does.
    // The org the policy already decided on, carried into the payload: the fanout's reads are
    // tenant-scoped and a job has no request behind it to derive one from.
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
    return post;
  },
});

export const createComment = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, body: t.string.min(1).max(COMMENT_MAX) }),
  output: CommentView,
  policy: postRead,
  cache: { invalidates: [tag.comment, tag.post] },
  mcp: { expose: true, description: 'Comment on a post the actor can read' },
  async handle({ input, ctx }) {
    const comment = await ctx.posts.comment(postId(input.postId), input.body);
    // The author hears about it (`commentPosted`, a notifier — a job), enqueued in this request's
    // transaction: a rolled-back comment mails nobody. The two names ride in the payload because
    // the mail renders on a worker with no request to read them through.
    const [post, me] = await Promise.all([ctx.posts.byId(postId(input.postId)), ctx.orgs.me()]);
    await commentPosted.enqueue({
      params: {
        postId: post.id,
        orgId: input.orgId,
        commentId: comment.id,
        commenterId: me.id,
        title: post.title,
        commenter: me.name,
      },
    });
    return comment;
  },
});

/**
 * Start an export of every post in the org. The work is `exportPosts`, a job, enqueued in this
 * request's transaction; the answer is where the artifact will land — `manifest.json` under
 * `prefix` once the job has written it. The id is minted here, so one request is one artifact and
 * a retried request (same idempotency key) is the same one.
 */
export const requestPostsExport = action({
  input: t.object({ orgId: t.uuid }),
  output: t.object({ exportId: t.uuid, prefix: t.string }),
  policy: postExport,
  idempotent: true,
  mcp: { expose: true, description: 'Export every post of the actor’s org as CSV to storage' },
  async handle({ input }) {
    const target = { orgId: input.orgId, exportId: crypto.randomUUID() };
    await exportPosts.enqueue(target);
    return { exportId: target.exportId, prefix: postsExportPrefix(target) };
  },
});

/**
 * The one model call in Postly. There is no `llm` primitive — the framework has eight and a model
 * call is not one of them — so this is an `action` built by a factory, which is what gives it the
 * same policy, the same MCP projection, the same OpenAPI operation and the same contract tests as
 * every other command in this file.
 *
 * `orgId` is in the input for the usual reason: `postRead` decides on it. The named rule matters
 * more here than elsewhere — an inline `can('post:read')` would carry the grant and drop the
 * tenancy predicate, and "summarise any post by id" is exactly the read that must not cross an org.
 */
export const summarize = llm({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.array(t.string) }),
  policy: postRead,
  prompt: summarizePrompt,
  // The one declared place a model call loads data: the input is an id, the prompt needs the row
  // behind it, and a reader can see exactly what was sent.
  vars: async ({ input, ctx }) => {
    const post = await ctx.posts.byId(postId(input.postId));
    return { title: post.title, body: post.body, locale: ctx.locale };
  },
  // No `scope`, and that is now the safe answer: the default partitions on the calling ACTOR.
  // Cosine similarity has no notion of a tenant, so the old `'global'` default answered one org
  // with another's summary — a shared store has to be written down (`scope: () => 'global'`).
  cache: { semantic: { threshold: 0.97, ttl: '7d' } },
  // Refused before a token is spent, never truncated after — a runaway loop costs one refusal
  // instead of a bill.
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  // The answer is two sentences and four tags. Left at the 4,096-token default, the pre-flight
  // estimate — the WHOLE ceiling at the output rate — priced every call at 6 cents against the
  // 5-cent `costPerCall` above, so `summarize` was refused for every post before a token was sent.
  maxTokens: 512,
  mcp: { expose: true, description: 'Summarise a post into two sentences and up to four tags' },
});

/** How many posts one `summarizePosts` call may fan out over: a page of the feed, never a backlog. */
export const SUMMARIZE_POSTS_MAX = 20;

/**
 * The feed's "catch me up": many posts summarised in one call. `hive()` is the fan-out as an
 * action — each member is a `summarize` call with that action's own policy, input parse, cache and
 * budget, so a post another org owns fails as ITS member (`X_FORBIDDEN`) and never as the batch.
 *
 * `split` derives every member from the input alone, and the org it carries is the one `postRead`
 * already decided on. `'collect'`: one unreadable post should not cost the reader the other
 * nineteen summaries. A backlog of thousands is a `backfill()`, not a longer list here.
 */
export const summarizePosts = hive({
  input: t.object({
    orgId: t.uuid,
    // A refinement, so the bound is ON the schema and every projection states it: the array schema
    // carries no item-count bound of its own.
    postIds: t.refine(t.array(t.uuid), {
      name: 'a-page-of-posts',
      message: `postIds names between 1 and ${SUMMARIZE_POSTS_MAX} posts`,
      check: (ids) => ids.length >= 1 && ids.length <= SUMMARIZE_POSTS_MAX,
    }),
  }),
  member: summarize,
  split: ({ input }) => input.postIds.map((id) => ({ postId: id, orgId: input.orgId })),
  concurrency: 4,
  onMemberError: 'collect',
  // The whole fan-out's ceiling: every member's `tokensIn` bound, times the page.
  budget: { tokensPerRun: 8000 * SUMMARIZE_POSTS_MAX },
  policy: postRead,
  mcp: { expose: true, description: 'Summarise up to twenty posts of the actor’s org at once' },
});

/**
 * "Is my draft ready?" — a tool-using model run, still an action: `agent()` returns one, so it has
 * a route, an MCP tool and a contract like the rest. Its one tool is `summarize`, the action above,
 * run under the SAME actor through its own policy — the model can ask how the feed will present the
 * post, and can never name who is asking. `agentJob()` runs it in the background (`./jobs.ts`).
 *
 * Read-only by construction: the only tool reads. A review that wrote would need every tool to be
 * idempotent first, because a job attempt that loses its lease runs the agent again from the top.
 */
export const reviewDraft = agent({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: t.object({ verdict: t.enumerated('ready', 'revise'), notes: t.string }),
  prompt: reviewDraftPrompt,
  vars: async ({ input, ctx }) => {
    const post = await ctx.posts.byId(postId(input.postId));
    return { title: post.title, body: post.body, locale: ctx.locale };
  },
  tools: [summarize],
  maxTurns: 3,
  maxToolResultChars: 2000,
  // A verdict and three sentences per turn; the ceiling is what every turn's estimate is priced at.
  maxTokens: 1024,
  budget: { tokensPerRun: 24_000, costPerCall: { minor: 10, currency: 'USD' } },
  policy: postRead,
  mcp: { expose: true, description: 'Review a draft post and say whether it is ready to publish' },
});
