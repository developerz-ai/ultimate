/**
 * What `ctx.posts` and `ctx.orgs` are. The framework carries an ambient context so no signature in
 * the app grows a `ctx` argument twice; this file is where Postly says which services ride on it,
 * and with what shape.
 *
 * The view types are imported **as types only**, exactly like `shared/client.ts` imports `Api`: no
 * module-graph edge exists from `shared/` to a feature's implementation, so `shared/` stays a leaf
 * and `site/` keeps its 0kb baseline. The contract lives here; each feature's `service.ts`
 * implements it and is installed once with `ctxOf({ services })` at boot.
 *
 * Every method speaks the feature's own view type. A service that invented a second row shape
 * would be a second schema to keep in step with the entity — the drift this file exists to avoid.
 */

import type { Member as MemberRow } from '@postly/db';
import type {
  AppLocale,
  AppTheme,
  AppZone,
  MemberId,
  OrgId,
  PlanCode,
  PostId,
} from '@postly/domain';
import type { UploadGrant, UploadRequest } from '@ultimat3/storage';
import type { InviteInput, MemberView, OrgView, UpgradeReceipt } from '../app/orgs/entity';
import type {
  CommentView,
  CreatePostInput,
  DraftReview,
  PostSummary,
  PostView,
  ReviewView,
} from '../app/posts/entity';
import type { PostRow } from '../app/posts/policy';
import type { ConnectInput, ConnectionView, RunKeyIssued, RunStarted } from '../app/runs/entity';
import type { RunOwner } from '../app/runs/policy';
import type { AddEndpointInput, EndpointIssued, RemoveEndpointInput } from '../app/webhooks/entity';

export interface PostsService {
  byId(postId: PostId): Promise<PostView>;
  bySlug(slug: string): Promise<PostView>;
  createDraft(input: CreatePostInput): Promise<PostView>;
  publish(postId: PostId): Promise<PostView>;
  like(postId: PostId): Promise<PostView>;
  unlike(postId: PostId): Promise<PostView>;
  comment(postId: PostId, body: string): Promise<CommentView>;
  /** Upsert the post's one review, made for the acting member. A second write is the same row. */
  recordReview(postId: PostId, review: DraftReview): Promise<ReviewView>;
  /** A post inside a NAMED org, no acting member needed: a job's read. `null` when absent. */
  inOrg(orgId: OrgId, postId: PostId): Promise<PostView | null>;
  /** The post's latest review, `null` before any. */
  review(postId: PostId): Promise<ReviewView | null>;
  /** What the digest mails. Bounded and ordered, so a big org does not mail a book. */
  publishedSince(orgId: OrgId, since: Date): Promise<PostSummary[]>;
  /**
   * The two columns `postPublish` decides about, for `publishPost`'s `row:` loader. Scoped to the
   * ACTING member's org — not to an org a caller names — because the loader runs before the guard,
   * so a read across tenants raises `X_TENANCY_ACTOR_MISMATCH` where the contract says
   * `X_FORBIDDEN`. `null` means "no such post this member can see", which is what the rule denies
   * on; the org the input names is still compared against the member's own inside `postPublish`.
   */
  authorship(postId: PostId): Promise<PostRow | null>;
}

export interface OrgsService {
  byId(orgId: OrgId): Promise<OrgView>;
  invite(input: InviteInput): Promise<MemberView>;
  upgrade(plan: PlanCode): Promise<UpgradeReceipt>;
  /**
   * Every field optional: `savePreferences`'s bulk save writes all four, but the mutators `setTheme`
   * and `toggleDigestOptIn` each write one — a partial write is what keeps the field a single
   * mutator owns from also needing a second, competing write path through this method.
   */
  savePreferences(values: {
    locale?: AppLocale;
    tz?: AppZone;
    theme?: AppTheme;
    digestOptIn?: boolean;
    /** The WHOLE row: the preference actions answer it as a record the page store adopts. */
  }): Promise<MemberRow>;
  /** A member and their org, read inside a NAMED org — what a background run acts for. */
  actingFor(orgId: OrgId, memberId: MemberId): Promise<{ member: MemberView; org: OrgView }>;
  /** A member inside a NAMED org, no acting member needed: what a job reads. */
  memberIn(orgId: OrgId, memberId: MemberId): Promise<MemberView>;
  memberById(memberId: MemberId): Promise<MemberView>;
  /**
   * The acting member's own row. No argument, for the reason `grantAvatarUpload` has none: the
   * member is the actor's, so there is no value a caller could pass to widen it. The one read of
   * the `tz`/`locale` columns the digest schedules off, for a surface that has the actor and not
   * the row — `packages/mcp`'s `digestPreview` is the caller.
   */
  me(): Promise<MemberView>;
  /**
   * A presigned PUT for the acting member's own avatar. No `orgId` parameter on purpose: the key
   * is derived from the actor's org, so there is no value a caller could pass to widen it.
   */
  grantAvatarUpload(request: UploadRequest): Promise<UploadGrant>;
  /** The acting member's avatar as a short-lived signed URL, `null` until they upload one. */
  avatarUrl(): Promise<string | null>;
  digestRecipients(orgId: OrgId): Promise<MemberView[]>;
  /** Cross-tenant on purpose, and only reachable from the scheduler's job. */
  allDigestRecipients(): Promise<MemberView[]>;
}

export interface RunsService {
  connect(input: ConnectInput): Promise<ConnectionView>;
  /** Enqueue one sync of the connection; the answer is the handle the console follows. */
  start(orgId: string, connectionId: string): Promise<RunStarted>;
  /** `null` when the run asked no such prompt in the acting org — what `canRunAct` denies on. */
  promptOwner(runId: string, prompt: number): Promise<RunOwner | null>;
  answer(runId: string, prompt: number, answer: string): Promise<void>;
  /** `null` when no such run exists in the acting org. */
  runOwner(runId: string): Promise<RunOwner | null>;
  cancel(runId: string): Promise<void>;
  issueKey(orgId: string): Promise<RunKeyIssued>;
  keyOwner(keyId: string): Promise<RunOwner | null>;
  revokeKey(keyId: string): Promise<boolean>;
}

export interface WebhooksService {
  /** Register a receiver; the answer is the only copy of its secret. */
  addEndpoint(input: AddEndpointInput): Promise<EndpointIssued>;
  /** Revoke a receiver of the org: its row, its secret and its delivery rows go. */
  removeEndpoint(input: RemoveEndpointInput): Promise<{ endpointId: string }>;
  /** One `post.published` delivery per live endpoint of the acting member's org. */
  announcePublished(post: PostView): Promise<number>;
}

/**
 * Four services, and all are registered: `defineService('posts', …)`, `defineService('orgs', …)`,
 * `defineService('runs', …)` and `defineService('webhooks', …)` run when `apps/web/api/index.ts` imports their modules, which is
 * this app's whole boot.
 *
 * A `session` and a `channel` were declared here until 2026-08 and neither was ever registered —
 * `CtxServices` carries a string index signature, so `ctx.session` compiled and was `undefined` at
 * runtime, and a declaration nothing installs is a lie the type system helps tell. The member row
 * moved onto the actor's own facts (`shared/actor.ts`); the channel publish is gone from
 * `app/posts/jobs/` with the reason it cannot exist yet.
 */
declare module '@ultimat3/core' {
  interface CtxServices {
    readonly posts: PostsService;
    readonly orgs: OrgsService;
    readonly runs: RunsService;
    readonly webhooks: WebhooksService;
  }
}
