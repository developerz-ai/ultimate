// `subscribePush`, the settings slice's `pushSubscribe()` action — one primitive per file, the layout `x g` writes.
//
// Preference writes. Settings are a thin edit of the member row, but "thin" is not a location:
// an `action` is only ever declared in a feature's `actions/`, so the settings slice gets one
// rather than a loose `settings-actions.ts` beside the page.
//
// Theme and digest opt-in ALSO have their own mutators beside this file — `setTheme` and
// `toggleDigestOptIn` — because both want to apply instantly and survive offline, unlike locale
// and timezone, which stay behind a deliberate "Save" click (changing either mid-session
// reformats every date and string on the page, which is not worth applying before the member
// confirms it). Narrowing this action's input to drop them would be a breaking contract change
// for no reason: both paths write the same partial `orgs.savePreferences`, so a caller who still
// saves all four in one request keeps working exactly as before.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { memberOf } from '@postly/core';
import { pushSubscribe } from '@ultimat3/pwa';

/**
 * Web Push for this browser. Factories over `action` — each one is a real action with its route,
 * typed client and contract tests — storing the subscription against the member the request ran as
 * (never an id the body names). `member:self` because subscribing is a preference of your own; the
 * framework refuses an agent whatever the permission says.
 */
export const subscribePush = pushSubscribe({
  permission: 'member:self',
  check: ({ actor }) => memberOf(actor) !== null,
});
