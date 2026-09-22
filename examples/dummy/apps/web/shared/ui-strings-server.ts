/**
 * The server half of `ui-strings.ts`: the `ui.*` strings an island's `AsyncRegion` reads, resolved
 * through the app's translator in the request's locale — the error report's four labels, the
 * empty state's fallback and the retry control.
 */

import type { useT } from '@postly/i18n';
import { UI_KEYS } from '@ultimat3/ui';
import type { UiStrings } from './ui-strings';

const REGION_KEYS = [
  UI_KEYS.empty,
  UI_KEYS.error,
  UI_KEYS.errorCode,
  UI_KEYS.errorCause,
  UI_KEYS.errorFix,
  UI_KEYS.retry,
] as const;

export function uiStringsFor(t: ReturnType<typeof useT>): UiStrings {
  const strings: Record<string, string> = {};
  for (const key of REGION_KEYS) {
    const text = t.raw(key);
    if (text !== undefined) strings[key] = text;
  }
  return strings;
}
