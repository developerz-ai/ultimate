/**
 * The name a reader sees for a member: theirs, or the catalog's "former member" label when the row
 * was erased (`ERASED_MEMBER_NAME`). One function for pages, structured data and mail, so no surface
 * prints the stored placeholder.
 */

import { isErasedMember } from '@postly/domain';

/** Any translator that knows the label — a page's `useT()` or a mail template's `t`. */
export type FormerMemberT = (key: 'common.formerMember') => string;

export const memberName = (t: FormerMemberT, name: string): string =>
  isErasedMember(name) ? t('common.formerMember') : name;
