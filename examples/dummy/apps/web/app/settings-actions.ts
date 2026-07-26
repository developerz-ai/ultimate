/**
 * Preference writes. Not a feature of its own — settings are a thin edit of the member row, so
 * the action lives beside the page that uses it and delegates to `ctx.orgs`.
 */

import { tag } from '@postly/db';
import { SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import { action } from '@ultimat3/action';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { MemberView } from './orgs/entity';

export const savePreferences = action({
  input: t.object({
    locale: t.enumerated(...SUPPORTED_LOCALES),
    /** IANA zone from the curated list; an arbitrary string would defeat the CHECK constraint. */
    tz: t.enumerated(...SUPPORTED_ZONES),
    /** Stored on the member, not in localStorage: the same person, the same theme, every device. */
    theme: t.enumerated(...THEMES),
    digestOptIn: t.boolean.default(true),
  }),
  output: MemberView,
  policy: can('member:self'),
  cache: { invalidates: [tag.member] },
  mcp: {
    expose: true,
    description: 'Update the acting member’s locale, timezone, theme and digest opt-in',
  },
  async handle({ input, ctx }) {
    return ctx.orgs.savePreferences(input);
  },
});
