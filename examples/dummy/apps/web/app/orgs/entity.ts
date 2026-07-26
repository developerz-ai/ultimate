/**
 * The orgs feature's view schemas: what an org, a membership and a billing receipt look like on
 * the wire. Money crosses the wire as minor units plus a currency — never as a formatted string,
 * because a client that receives "€18,00" cannot do arithmetic with it.
 */

import {
  BILLING_CURRENCIES,
  MEMBER_ROLES,
  PLAN_CODES,
  SUPPORTED_LOCALES,
  SUPPORTED_ZONES,
  THEMES,
} from '@postly/domain';
import { t } from '@ultimat3/schema';

export const MoneyView = t.object({
  minor: t.number.integer,
  currency: t.enumerated(...BILLING_CURRENCIES),
});

export const OrgView = t.object({
  id: t.uuid,
  slug: t.string,
  name: t.string,
  planCode: t.enumerated(...PLAN_CODES),
  billingCurrency: t.enumerated(...BILLING_CURRENCIES),
  seats: t.number.integer.atLeast(1),
  seatsUsed: t.number.integer.atLeast(0),
});

export type OrgView = typeof OrgView.infer;

export const MemberView = t.object({
  id: t.uuid,
  orgId: t.uuid,
  email: t.string.email,
  name: t.string,
  role: t.enumerated(...MEMBER_ROLES),
  tz: t.enumerated(...SUPPORTED_ZONES),
  locale: t.enumerated(...SUPPORTED_LOCALES),
  theme: t.enumerated(...THEMES),
  digestOptIn: t.boolean,
});

export type MemberView = typeof MemberView.infer;

/** What the org is charged today, what it will pay monthly, and what was credited back. */
export const UpgradeReceipt = t.object({
  org: OrgView,
  charge: MoneyView,
  credit: MoneyView,
  nextPeriod: MoneyView,
});

export type UpgradeReceipt = typeof UpgradeReceipt.infer;

export const InviteInput = t.object({
  email: t.string.email,
  role: t.enumerated(...MEMBER_ROLES).default('author'),
  /** New members inherit the inviter's preferences until they change them in settings. */
  tz: t.enumerated(...SUPPORTED_ZONES).optional(),
  locale: t.enumerated(...SUPPORTED_LOCALES).optional(),
});

export type InviteInput = typeof InviteInput.infer;
