/** The public surface of @postly/domain. Explicit — never `export *`. */

export { DomainError, InvariantViolation } from './errors';
export type { CommentId, MemberId, OrgId, PostId } from './ids';
export { commentId, memberId, orgId, postId } from './ids';
export type { BillingCurrency, Plan, PlanCode } from './plans';
export {
  assertBillingCurrency,
  BILLING_CURRENCIES,
  isUpgrade,
  PLAN_CATALOG,
  PLAN_CODES,
  PLAN_ORDER,
  priceOf,
  seatLimit,
} from './plans';
export type { PostStatus } from './posts';
export {
  assertValidSlug,
  EXCERPT_MAX,
  excerptOf,
  hasCoherentPublishState,
  isValidSlug,
  isValidTitle,
  POST_STATUSES,
  SLUG_MAX,
  SLUG_PATTERN,
  slugify,
  TITLE_MAX,
} from './posts';
export type { AppLocale, AppTheme, AppZone } from './preferences';
export {
  DEFAULT_LOCALE,
  DEFAULT_THEME,
  DEFAULT_ZONE,
  DIGEST_LOCAL_HOUR,
  isSupportedLocale,
  isSupportedZone,
  SUPPORTED_LOCALES,
  SUPPORTED_ZONES,
  THEMES,
} from './preferences';
export type { MemberRole } from './roles';
export { canAuthor, isAtLeast, isOrgAdmin, MEMBER_ROLES, ROLE_RANK } from './roles';
