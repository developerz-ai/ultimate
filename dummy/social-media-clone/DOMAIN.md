# Domain model

The eight primitives, filled in. Every row below is a declaration an agent writes once; the
framework projects HTTP, OpenAPI, the typed client, the MCP tool, the job handle and the tests.

Package layout follows the reference app: `packages/domain` (pure types, no I/O) →
`packages/db` (entities, migrations, tags, seeds) → `packages/core` (business services) →
`packages/{i18n,ui,mcp}` → `apps/{web,admin}`. Inside `apps/web`: surface first (`site/`, `app/`,
`api/`, `shared/`), then feature.

## Tenancy — the one structural decision

The reference app is multi-tenant on `orgId`. **A social network is not.** Its natural scope is the
*viewer*, and the sharp edge is that "who may see this row" is a graph question (friends, friends-of
-friends, blocks), not a column comparison. Declaring a tenant column here would be cargo-culting:
`X_TENANCY_UNSCOPED` would fire on every global feed read, and the escape hatch does not exist.

Decision: **no tenant column.** Visibility is a policy predicate over an `audience` column plus the
edge table. This is deliberately the harder path — it is the one that will find out whether the
policy layer holds up when authorization is relational rather than columnar. Expect this to surface
a framework gap; that is the point of the exercise.

## Entities — `packages/db/src/schema/`

| Entity | Columns of note | Invariants / indexes |
|---|---|---|
| `users` | `id`, `handle` unique, `email` unique, `displayName`, `bio`, `avatarKey` nullable, `role` (`member`\|`admin`), `locale`, `tz`, `theme`, `verifiedAt` nullable, `createdAt` | handle shape (lowercase slug), email contains `@`; index on `handle` |
| `credentials` | `userId`, `passwordHash`, `updatedAt` | split from `users` so a profile read never loads a hash |
| `sessions` | framework-owned via `@ultimat3/auth` | — |
| `follows` | `followerId`, `followeeId`, `createdAt` | PK `(followerId, followeeId)` — the composite key *is* the idempotency mechanism, same trick as `likes`. Index on `followeeId` |
| `friendships` | `requesterId`, `addresseeId`, `status` (`pending`\|`accepted`\|`declined`), `respondedAt` nullable | PK `(requesterId, addresseeId)`; invariant: `status = 'accepted'` ⇒ `respondedAt` not null; **canonical ordering invariant** — `requesterId < addresseeId` is *not* imposed, because direction carries meaning (who asked); instead a partial unique index prevents the mirror row |
| `blocks` | `blockerId`, `blockedId` | PK pair. Checked before every visibility decision |
| `posts` | `authorId`, `body`, `audience` (`public`\|`friends`\|`private`), `mediaCount`, `likeCount`, `commentCount`, `publishedAt`, `deletedAt` nullable | counters denormalised so the feed query stays bounded; `deletedAt` presence turns on soft delete; index `(authorId, publishedAt desc)`, partial index for the public feed |
| `media` | `id`, `postId` nullable, `ownerId`, `key`, `kind` (`image`\|`video`), `bytes`, `width`/`height` nullable, `state` (`pending`\|`attached`\|`orphan`) | `postId` nullable is what makes the upload-then-attach flow possible; the orphan sweep reads `state` |
| `comments` | `postId`, `authorId`, `body`, `deletedAt` | index `(postId, createdAt)` |
| `likes` | `postId`, `userId` | PK pair — replay-safe by construction |
| `conversations` | `id`, `kind` (`direct`\|`group`), `title` nullable | |
| `participants` | `conversationId`, `userId`, `lastReadAt` | PK pair |
| `messages` | `conversationId`, `authorId`, `body`, `mediaKey` nullable, `createdAt` | index `(conversationId, createdAt desc, id)` — total order, because the live query needs one |
| `notifications` | `userId`, `kind`, `actorId`, `subjectId`, `readAt` nullable | index `(userId, createdAt desc)` partial on unread |

Counters (`likeCount`, `commentCount`, `mediaCount`) are denormalised **and** owned by exactly one
mutator/action each, which recounts from the source table rather than incrementing — so a replayed
offline mutation converges instead of drifting.

## Policies — `apps/web/app/*/policy.ts`

Permissions: `post:create`, `post:read`, `post:like`, `post:comment`, `post:delete`, `feed:read`,
`friend:request`, `friend:respond`, `message:send`, `message:read`, `user:block`, `profile:edit`,
`admin:read`, `admin:write`.

The load-bearing rule is `postVisible`. Predicates are **synchronous** — a live query re-evaluates
one per subscriber per change, so it may not touch the database. Therefore the viewer's friend set
and block set are resolved **once per request** into the actor and read from memory:

```
postVisible(actor, row) =
  not blocked(actor, row.authorId)          // either direction
  and row.deletedAt === null
  and ( row.audience === 'public'
      | row.audience === 'friends' and friends(actor, row.authorId)
      | row.authorId === actor.id )
```

`admin/admin` is **view-only**, and that is a permission fact, not a UI fact: the seeded admin holds
`admin:read` and never `admin:write` / `admin:destroy`. A button it cannot press is never rendered
*and* the call is refused by the same decision — one door.

## Actions, mutators, queries — the surface

| Kind | Name | Notes |
|---|---|---|
| action | `signUp` | **hCaptcha-gated.** Fails closed on network error/timeout |
| action | `signIn` | captcha after N failures; rate-limited per IP + per account |
| action | `createPost` | derives nothing from the client it can compute itself; attaches pending `media` by key |
| action | `deletePost` | soft delete; invalidates `post`, `feed` |
| action | `addComment` / `deleteComment` | recount, never increment |
| action | `requestFriend` / `respondFriend` | `respondFriend` loads the row for the policy (`row:` loader), same shape as the reference app's `publishPost` |
| action | `blockUser` / `unblockUser` | invalidates the viewer's feed |
| action | `sendMessage` | publishes to the conversation channel in the same transaction |
| action | `requestUpload` | the upload-URL factory over `action` — see the uploads work |
| mutator | `likePost` / `unlikePost` | offline-capable, convergent: derives `likeCount` from `likedByMe`, never `+1` |
| mutator | `markRead` | notification/message read state; last-write-wins is correct here |
| query | `feed` (live) | cursor-paginated, ordered `(publishedAt desc, id)`, bounded |
| query | `postById`, `profileByHandle`, `comments`, `conversations`, `messages` (live), `notifications` (live) | |
| query | `publicProfile`, `publicPost` | anonymous, for `site/` + SEO |

## Jobs and tasks

| Kind | Name | Why it is not inline |
|---|---|---|
| job | `fanOutNotification` | one write, N recipients |
| job | `processMedia` | probe, transcode variants, set `state = 'attached'` |
| job | `sendDigestEmail` | per-user local time, DST-correct — the two-stage fan-out pattern |
| job | `rebuildFeedCache` | |
| task | `nightlyDigest` `0 3 * * *` UTC | enqueues only |
| task | `sweepOrphanMedia` hourly | `media.state = 'pending'` older than 24h |
| task | `resetDemo` hourly | restores the seed graph — this is a public demo |

## Routes

`site/` (static/ISR, 0kb JS, SEO): landing, `/u/[handle]` public profile, `/p/[id]` public post,
`/about`, `/offline`.
`app/` (authed): `/feed`, `/p/[id]`, `/u/[handle]`, `/friends`, `/messages/[id]`, `/notifications`,
`/settings`.
`admin/`: users, posts, media, jobs, DB insights, feature flags.

## Seeds

Deterministic — `id('user:ada')` is a stable UUID v5 of the label, every timestamp a literal. Same
rows, same ids, every run. `user/user` and `admin/admin` are seeded accounts. Stock images and short
videos are fetched once into R2 by a script and referenced by key, never committed.

Coverage the seed must guarantee, because these are the cases that find bugs: a blocked pair, a
pending friend request in both directions, a `friends`-audience post the viewer may not see, a
soft-deleted post, a post with 0 media and one with several, two locales, and at least four IANA
zones including one southern-hemisphere and one without DST.
