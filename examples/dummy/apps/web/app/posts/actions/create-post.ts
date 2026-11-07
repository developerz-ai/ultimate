// `createPost`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { tag } from '@postly/db';
import { postsPerDay, postsPerMinute } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { planOf } from '../../../shared/actor';
import { CreatePostInput, PostView } from '../entity';
import { PostSlugTaken } from '../errors';
import { postsQuotaWarning } from '../jobs/posts-quota-warning';
import { postCreate } from '../policy';

export const createPost = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database. A predicate that fetched a row would cost one query per live subscriber.
  input: CreatePostInput.extend({ orgId: t.uuid }),
  output: PostView,
  policy: postCreate,
  // Closed: see `publishPost`. A slug is unique across every org, so a taken one is a refusal.
  errors: [PostSlugTaken.code],
  cache: { invalidates: [tag.feed] },
  mcp: { expose: true, description: 'Create a draft post in the actor’s organisation' },
  // The org's plan decides both numbers, resolved per call from the acting org — the catalog is
  // Postly's (`POST_ALLOWANCES`), the counting is the framework's. The burst is per actor and
  // spent before the input is read; the meter is the ORG's day, UTC, drawn on every surface (the
  // editor, an agent's tool call, a job) once the policy admitted the call, and never twice for a
  // replayed `Idempotency-Key`. At 80% `postsQuotaWarning` is queued, once per org per day.
  rateLimit: { windowMs: 60_000, limit: ({ ctx }) => postsPerMinute(planOf(ctx)) },
  meter: {
    name: 'posts',
    period: 'day',
    limit: ({ ctx }) => postsPerDay(planOf(ctx)),
    warnAt: 0.8,
    onWarn: postsQuotaWarning,
  },
  async handle({ input, ctx }) {
    return ctx.posts.createDraft(input);
  },
});
