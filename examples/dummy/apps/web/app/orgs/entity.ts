/**
 * The orgs feature's view schemas: what an org, a membership and a billing receipt look like on
 * the wire. Money crosses the wire as minor units plus a currency — never as a formatted string,
 * because a client that receives "€18,00" cannot do arithmetic with it.
 *
 * `t` comes from @ultimat3/schema here, not from a primitive package: this file declares no
 * primitive, so schema *is* its one import. Every primitive package re-exports the same object.
 */

import {
  BILLING_CURRENCIES,
  MEMBER_ROLES,
  PLAN_CODES,
  SUPPORTED_LOCALES,
  SUPPORTED_ZONES,
  THEMES,
} from '@postly/domain';
import { type Infer, t } from '@ultimat3/schema';

export const OrgView = t.object({
  id: t.uuid,
  slug: t.string,
  name: t.string,
  planCode: t.enumerated(...PLAN_CODES),
  billingCurrency: t.enumerated(...BILLING_CURRENCIES),
  seats: t.number.int().min(1),
  seatsUsed: t.number.int().min(0),
});

export type OrgView = Infer<typeof OrgView>;

export const MemberView = t.object({
  id: t.uuid,
  orgId: t.uuid,
  email: t.email,
  name: t.string,
  role: t.enumerated(...MEMBER_ROLES),
  tz: t.enumerated(...SUPPORTED_ZONES),
  locale: t.enumerated(...SUPPORTED_LOCALES),
  theme: t.enumerated(...THEMES),
  digestOptIn: t.boolean,
});

export type MemberView = Infer<typeof MemberView>;

/**
 * What the org is charged today, what it will pay monthly, and what was credited back.
 *
 * `t.money` and never a local `t.object({ minor, currency })`: money has ONE declaration in
 * `@ultimat3/schema` and a restatement is a second shape to keep in step — this file carried one
 * (`MoneyView`, with `currency` narrowed to `BILLING_CURRENCIES`) and it disagreed with the
 * `Money` every function in `@postly/core` returns, so three fields of this receipt did not
 * typecheck against the value the service puts in them. The currency is still checked, at the one
 * boundary that can: `assertBillingCurrency` in `@postly/domain`.
 */
export const UpgradeReceipt = t.object({
  org: OrgView,
  charge: t.money,
  credit: t.money,
  nextPeriod: t.money,
});

export type UpgradeReceipt = Infer<typeof UpgradeReceipt>;

/**
 * What `grantAvatarUpload` hands a browser: where to PUT the bytes, and the two constraints the
 * URL was signed with. `url` is `t.string` and not `t.url` because a disk mints a route-relative
 * capability (`/_storage/<disk>/<key>?…`), which is not an absolute URL and must not become one.
 */
export const AvatarUploadGrant = t.object({
  key: t.string,
  url: t.string,
  method: t.enumerated('PUT'),
  contentType: t.string,
  maxBytes: t.number.int(),
  /** Epoch ms. The grant's view of the window; the signature is what enforces it. */
  expiresAt: t.number.int(),
});

export type AvatarUploadGrant = Infer<typeof AvatarUploadGrant>;

/** A member's current avatar, `null` until they upload one. */
export const AvatarView = t.object({ url: t.nullable(t.string) });

export type AvatarView = Infer<typeof AvatarView>;

export const InviteInput = t.object({
  email: t.email,
  role: t.enumerated(...MEMBER_ROLES).default('author'),
  /** New members inherit the inviter's preferences until they change them in settings. */
  tz: t.enumerated(...SUPPORTED_ZONES).optional(),
  locale: t.enumerated(...SUPPORTED_LOCALES).optional(),
});

export type InviteInput = Infer<typeof InviteInput>;
