// The bottom bar's one rule beyond `currentOf`: five destinations at most. A sixth no longer fits
// a 320px phone at a touch target each, and the thumb cannot reach a scroll it cannot see.

import { invalidValueError } from '../errors';

export const BOTTOM_NAV_MAX = 5;

/** `items` unchanged, or `X_UI_INVALID_VALUE` naming the count when there are more than five. */
export function bottomNavItems<T>(items: readonly T[]): readonly T[] {
  if (items.length > BOTTOM_NAV_MAX) {
    throw invalidValueError(
      'BottomNav',
      `${items.length} items`,
      `at most ${BOTTOM_NAV_MAX} destinations — move the rest into AppShell's sidebar (NavList)`,
    );
  }
  return items;
}
