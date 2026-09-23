/**
 * Preference writes. Settings are a thin edit of the member row, but "thin" is not a location:
 * an `action` is only ever declared in `api/` or in a feature's `actions.ts`, so the settings
 * slice gets one rather than a loose `settings-actions.ts` beside the page.
 *
 * Theme and digest opt-in ALSO have their own mutators in `mutator.ts` — `setTheme` and
 * `toggleDigestOptIn` — because both want to apply instantly and survive offline, unlike locale
 * and timezone, which stay behind a deliberate "Save" click (changing either mid-session
 * reformats every date and string on the page, which is not worth applying before the member
 * confirms it). Narrowing this action's input to drop them would be a breaking contract change
 * for no reason: both paths write the same partial `orgs.savePreferences`, so a caller who still
 * saves all four in one request keeps working exactly as before.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { members, tag } from '@postly/db';
import { SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
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
  // The whole `members` row, because that is what `updatePreferences` returns: an entity row
  // schema is what makes the answer a RECORD the page store adopts (plan 101), where the
  // hand-written `MemberView` was a partial projection no store could safely merge.
  output: members.$schema,
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
