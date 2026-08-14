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
import type { SessionService } from './actor';

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
   * org the caller names: `null` then means "no such post in that org", which the rule reads as a
   * denial exactly as it reads a row from another org — and an unscoped read of a tenant-columned
   * entity is `X_TENANCY_UNSCOPED`, so the org is not optional here.
   */
  authorship(orgId: OrgId, postId: PostId): Promise<PostRow | null>;
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

/** Tier 1 realtime: a topic anything server-side can announce onto. */
export interface Channel {
  publish(message: Readonly<Record<string, unknown>>): Promise<void>;
}

declare module '@ultimat3/core' {
  interface CtxServices {
    readonly posts: PostsService;
    readonly orgs: OrgsService;
    /** The app half of the actor — org, orgs, member row. See `shared/actor.ts`. */
    readonly session: SessionService;
    channel(name: string): Channel;
  }
}
