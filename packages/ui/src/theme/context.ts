// The ambient presentation contract every component reads: theme, locale, tz, currency, direction,
// translator. Formatting components take nothing from a process-wide default — it arrives from
// `UiProvider` where a Solid runtime is registered, and from the request everywhere else.

import type { Translator } from '@ultimat3/i18n';
import {
  createTranslator,
  currentDirection,
  currentLocale,
  type Direction,
  directionOf,
  type Locale,
  useI18n,
} from '@ultimat3/i18n';
import { currentTimeZone, type TimeZone } from '@ultimat3/time';
import type { Theme } from '../tokens/tokens';
import { hasSolidRuntime } from './runtime-slot';
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

/**
 * The presentation context of a server render, read from the request the framework already
 * resolved: `currentLocale()` and `currentTimeZone()` are the ambient answers `@ultimat3/i18n` and
 * `@ultimat3/time` keep on the request context, and `useI18n()` is the translator built from the
 * registered catalogs. No second ambient store, and no process-wide default — outside a request
 * each of them returns its own configured fallback, which is where `defaultUiContext()`'s values
 * come from in the first place.
 *
 * `theme` and `currency` have no ambient source and are not given one. The server cannot know the
 * theme — `data-theme` is decided in the browser by the anti-flash script — and a default display
 * currency is business convention: a `Money` carries its own, and an app that wants another for
 * bare minor units wraps `<Money currency="EUR">` once (axiom 8).
 */
export function ambientUiContext(): UiContextValue {
  return {
    theme: 'light',
    locale: currentLocale(),
    timeZone: currentTimeZone(),
    currency: UI_DEFAULT_CURRENCY,
    dir: currentDirection(),
    t: useI18n(),
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

/**
 * `solid()` is the loudness gate as much as the runtime lookup: it throws when a DOM render lost
 * its runtime, and returns the inert one when there is no DOM at all. On that second path the
 * Solid context is provably empty — an inert tree is walked outside every owner, so `useContext`
 * returns the context's default value even with a real runtime registered — so reading the
 * request's own answers is strictly more true than reading a provider that provided nothing.
 */
export function useUi(): UiContextValue {
  const runtime = solid();
  return hasSolidRuntime() ? runtime.useContext(uiContext()) : ambientUiContext();
}
