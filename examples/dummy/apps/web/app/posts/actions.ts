/**
 * The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
 * same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 * `llm` is the one other framework import here, and it is not a second primitive: it is a factory
 * that RETURNS an `action`, so `summarize` below belongs in this file for the same reason the rest
 * do — see `docs/idea/09-ai-first.md`.
 */

import { COMMENT_MAX, tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { llm } from '@ultimat3/ai';
import { CommentView, CreatePostInput, PostView } from './entity';
import { notifySubscribers } from './jobs';
import { postCreate, postPublish, postRead } from './policy';
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
  // per invocation instead of once per live subscriber. Deliberately NOT tenant-scoped: tenancy
  // is exactly what the rule compares, so filtering by the actor's org here would turn a
  // cross-org id into a null row and hand the rule back the fail-open it just lost.
  row: ({ input, ctx }) => ctx.posts.authorship(postId(input.postId)),
  // `blog` too: publishing is the ONE write that puts a post on the public, anonymous blog, and
  // `site/blog/*` sets `revalidate: { tags: [tag.blog] }`. Omitting it left those ISR pages
  // pinned to whatever the build saw — the tag existed, nothing ever evicted it.
  cache: { invalidates: [tag.post, tag.feed, tag.blog] },
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(postId(input.postId));
    // The job enqueues itself through its own handle, in the same transaction as the publish: a
    // rolled-back publish never mails anybody and a committed one always does.
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
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
    return ctx.posts.comment(postId(input.postId), input.body);
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
  // `scope` is not optional in a multi-tenant app: cosine similarity has no notion of a tenant, so
  // one shared cache would answer one org with another's summary.
  cache: { semantic: { threshold: 0.97, ttl: '7d', scope: ({ orgId }) => orgId } },
  // Refused before a token is spent, never truncated after — a runaway loop costs one refusal
  // instead of a bill.
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  mcp: { expose: true, description: 'Summarise a post into two sentences and up to four tags' },
});
