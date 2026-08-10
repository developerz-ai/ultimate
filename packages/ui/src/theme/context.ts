// The ambient presentation contract every component reads: theme, locale, tz,
// currency, direction, translator. Formatting components take nothing from a
// process-wide default — everything they need arrives here, via UiProvider.

import type { Translator } from '@ultimat3/i18n';
import { createTranslator, type Direction, directionOf, type Locale } from '@ultimat3/i18n';
import type { TimeZone } from '@ultimat3/time';
import type { Theme } from '../tokens/tokens';
import { type SolidContext, type SolidRuntime, solid } from './solid-adapter';

export type { Direction };

export interface UiContextValue {
  readonly theme: Theme;
  /** BCP-47 tag. Drives every Intl call in the tree. */
  readonly locale: Locale;
  /** IANA zone. A date is never formatted without one. */
  readonly timeZone: TimeZone;
  /** ISO-4217 default for <Money> when the value is bare minor units. */
  readonly currency: string;
  readonly dir: Direction;
  readonly t: Translator;
}

export const UI_DEFAULT_LOCALE: Locale = 'en';
export const UI_DEFAULT_TIME_ZONE = 'UTC' as TimeZone;
export const UI_DEFAULT_CURRENCY = 'USD';

/** Loud-miss translator: a forgotten catalog key renders ⟦key⟧, never blank. */
export function fallbackTranslator(locale: Locale = UI_DEFAULT_LOCALE): Translator {
  return createTranslator({}, locale);
}

export function defaultUiContext(): UiContextValue {
  return {
    theme: 'light',
    locale: UI_DEFAULT_LOCALE,
    timeZone: UI_DEFAULT_TIME_ZONE,
    currency: UI_DEFAULT_CURRENCY,
    dir: directionOf(UI_DEFAULT_LOCALE),
    t: fallbackTranslator(),
  };
}

let cached: {
  readonly runtime: SolidRuntime;
  readonly context: SolidContext<UiContextValue>;
} | null = null;

/**
 * Created lazily so importing this module never needs a Solid runtime, and keyed on the runtime
 * that built it: a context belongs to the reactive graph that created it, so handing a stale one
 * to a replaced runtime reads as a working provider while every consumer sees the default value.
 */
export function uiContext(): SolidContext<UiContextValue> {
  const runtime = solid();
  if (cached === null || cached.runtime !== runtime) {
    cached = { runtime, context: runtime.createContext(defaultUiContext()) };
  }
  return cached.context;
}

export function useUi(): UiContextValue {
  return solid().useContext(uiContext());
}
