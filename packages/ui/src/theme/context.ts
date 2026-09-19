// The ambient presentation contract every component reads: theme, locale, tz, currency, direction,
// translator. Formatting components take nothing from a process-wide default — it arrives from
// `UiProvider` where a Solid runtime is registered, and from the request everywhere else.
//
// This module is what every component's `useUi()` retains, so it imports NO value from
// `@ultimat3/i18n` or `@ultimat3/time`: the i18n barrel installs the framework catalog at import,
// and the request readers live in `ambient.ts`, reached through `ambient-slot.ts` (issue #490).

import type { Direction } from '@ultimat3/core';
import { directionOf } from '@ultimat3/core';
import type { Locale, Translator } from '@ultimat3/i18n';
import type { TimeZone } from '@ultimat3/time';
import type { Theme } from '../tokens/tokens';
import { registeredAmbientUiReader } from './ambient-slot';
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

/**
 * Loud-miss translator: a forgotten catalog key renders ⟦key⟧, never blank.
 *
 * Written here rather than as `createTranslator({}, locale)`, and behaviourally the same call: an
 * empty catalog has no key, so every lookup is a miss, `has` is false, `raw` is undefined and
 * `keys` is empty — `context.test.ts` holds each of those against `@ultimat3/i18n`'s own. What
 * the spelling buys is that a browser chunk with a `UiProvider` in it no longer reaches the i18n
 * barrel for a translator that cannot translate.
 */
export function fallbackTranslator(locale: Locale = UI_DEFAULT_LOCALE): Translator {
  const miss = (key: string): string => `⟦${key}⟧`;
  return Object.assign(miss, {
    has: (): boolean => false,
    raw: (): string | undefined => undefined,
    keys: (): string[] => [],
    locale,
  });
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

/**
 * `solid()` is the loudness gate as much as the runtime lookup: it throws when a DOM render lost
 * its runtime, and returns the inert one when there is no DOM at all. On that second path the
 * Solid context is provably empty — an inert tree is walked outside every owner, so `useContext`
 * returns the context's default value even with a real runtime registered — so reading the
 * request's own answers is strictly more true than reading a provider that provided nothing.
 *
 * Those answers come through the slot: `ambient.ts` registers `ambientUiContext` when the barrel
 * is imported, and a browser build — where this branch is unreachable — never has it. The
 * defaults are the fallback for a caller that reached this module without the barrel, which is
 * what `ambientUiContext()` itself answers outside a request.
 */
export function useUi(): UiContextValue {
  const runtime = solid();
  if (hasSolidRuntime()) return runtime.useContext(uiContext());
  const ambient = registeredAmbientUiReader();
  return ambient === null ? defaultUiContext() : ambient();
}
