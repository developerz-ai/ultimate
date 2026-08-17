/**
 * What `ctx.posts` and `ctx.orgs` are. The framework carries an ambient context so no signature in
 * the app grows a `ctx` argument twice; this file is where Postly says which services ride on it,
 * and with what shape.
 *
 * The view types are imported **as types only**, exactly like `shared/client.ts` imports `Api`: no
 * module-graph edge exists from `shared/` to a feature's implementation, so `shared/` stays a leaf
 * and `site/` keeps its 0kb baseline. The contract lives here; each feature's `service.ts`
 * implements it and is installed once with `createContext({ services })` at boot.
 *
 * Every method speaks the feature's own view type. A service that invented a second row shape
 * would be a second schema to keep in step with the entity — the drift this file exists to avoid.
 */

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
import type { CommentView, CreatePostInput, PostSummary, PostView } from '../app/posts/entity';
import type { PostRow } from '../app/posts/policy';

export interface PostsService {
  byId(postId: PostId): Promise<PostView>;
  bySlug(slug: string): Promise<PostView>;
  createDraft(input: CreatePostInput): Promise<PostView>;
  publish(postId: PostId): Promise<PostView>;
  like(postId: PostId): Promise<PostView>;
  unlike(postId: PostId): Promise<PostView>;
  comment(postId: PostId, body: string): Promise<CommentView>;
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
   * Every field optional: `actions.ts`'s bulk save writes all four, but `mutator.ts`'s `setTheme`
   * and `toggleDigestOptIn` each write one — a partial write is what keeps the field a single
   * mutator owns from also needing a second, competing write path through this method.
   */
  savePreferences(values: {
    locale?: AppLocale;
    tz?: AppZone;
    theme?: AppTheme;
    digestOptIn?: boolean;
  }): Promise<MemberView>;
  memberById(memberId: MemberId): Promise<MemberView>;
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

/**
 * Two services, and both are registered: `defineService('posts', …)` and `defineService('orgs', …)`
 * run when `apps/web/api/index.ts` imports their modules, which is this app's whole boot.
 *
 * A `session` and a `channel` were declared here until 2026-08 and neither was ever registered —
 * `CtxServices` carries a string index signature, so `ctx.session` compiled and was `undefined` at
 * runtime, and a declaration nothing installs is a lie the type system helps tell. The member row
 * moved onto the actor's own facts (`shared/actor.ts`); the channel publish is gone from
 * `app/posts/jobs.ts` with the reason it cannot exist yet.
 */
declare module '@ultimat3/core' {
  interface CtxServices {
    readonly posts: PostsService;
    readonly orgs: OrgsService;
  }
}
