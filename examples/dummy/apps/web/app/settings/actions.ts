/**
 * Preference writes. Settings are a thin edit of the member row, but "thin" is not a location:
 * an `action` is only ever declared in `api/` or in a feature's `actions.ts`, so the settings
 * slice gets one rather than a loose `settings-actions.ts` beside the page.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { tag } from '@postly/db';
import { SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { MemberView } from '../orgs/entity';
import { memberSelf } from '../orgs/policy';

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
  policy: memberSelf,
  cache: { invalidates: [tag.member] },
  mcp: {
    expose: true,
    description: 'Update the acting member’s locale, timezone, theme and digest opt-in',
  },
  async handle({ input, ctx }) {
    return ctx.orgs.savePreferences(input);
  },
});
