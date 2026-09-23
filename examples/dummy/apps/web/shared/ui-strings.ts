/**
 * The design system's own strings, carried into an island. `@ultimat3/ui` resolves `ui.*` keys
 * through the `UiProvider` translator, and a translator cannot cross the wire — so the server
 * resolves the few an island's components read, and `uiTranslator` hands them back as one. The
 * catalog is still the only place a word comes from; a key the server did not send renders
 * `⟦key⟧`, the same loud miss the design system's own fallback has.
 */

import type { UiProviderProps } from '@ultimat3/ui';

/** The translator `UiProvider` takes — named off its own prop, so this file reaches no i18n barrel. */
type Translator = NonNullable<UiProviderProps['t']>;

/** Key → already-translated text, as the server resolved it for this request. */
export type UiStrings = Readonly<Record<string, string>>;

export function uiTranslator(strings: UiStrings, locale: string): Translator {
  const lookup = (key: string): string =>
    Object.hasOwn(strings, key) ? (strings[key] ?? `⟦${key}⟧`) : `⟦${key}⟧`;
  return Object.assign(lookup, {
    has: (key: string): boolean => Object.hasOwn(strings, key),
    raw: (key: string): string | undefined =>
      Object.hasOwn(strings, key) ? strings[key] : undefined,
    keys: (): string[] => Object.keys(strings),
    locale,
  });
}
