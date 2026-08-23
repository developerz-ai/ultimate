// Every component reads its locale, zone and currency from this one context, so a silent change
// here is a silent change everywhere. Fake runtimes keep the contract provable with no Solid
// runtime installed — the state the package is actually published in.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { configureLocales, directionOf, isMiss, type Locale, localeConfig } from '@ultimat3/i18n';
import { configureTime, type TimeZone, timeConfig } from '@ultimat3/time';
import { UI_ERROR_CODES } from '../errors';
import {
  ambientUiContext,
  defaultUiContext,
  fallbackTranslator,
  UI_DEFAULT_CURRENCY,
  UI_DEFAULT_LOCALE,
  UI_DEFAULT_TIME_ZONE,
  type UiContextValue,
  uiContext,
  useUi,
} from './context';
import { clearSolidRuntime, setSolidRuntime } from './runtime-slot';
import type { SolidContext, SolidRuntime } from './solid-adapter';

/** Bun's test process has no DOM, so a browser is what has to be faked, never a server. */
function withDom<T>(fn: () => T): T {
  Object.assign(globalThis, { document: {}, window: {} });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
  }
}

function fakeRuntime(overrides: Partial<SolidRuntime> = {}): SolidRuntime {
  return {
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol(),
      defaultValue,
      Provider: () => null as never,
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      return [
        () => current,
        (next: T) => {
          current = next;
        },
      ] as const;
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: () => {},
    onCleanup: () => {},
    ...overrides,
  };
}

describe('defaults', () => {
  test('pins the exact default locale, time zone and currency', () => {
    expect(UI_DEFAULT_LOCALE).toBe('en');
    expect(UI_DEFAULT_TIME_ZONE).toBe('UTC');
    expect(UI_DEFAULT_CURRENCY).toBe('USD');
  });
});

describe('fallbackTranslator', () => {
  test('translating an unknown key renders the loud-miss format', () => {
    const t = fallbackTranslator();
    const rendered = t('some.unknown.key');
    expect(isMiss(rendered)).toBe(true);
    expect(rendered).toBe('⟦some.unknown.key⟧');
  });

  test('defaults to the default locale when none is given', () => {
    const t = fallbackTranslator();
    expect(t.locale).toBe(UI_DEFAULT_LOCALE);
  });

  test('honors an explicit locale', () => {
    const t = fallbackTranslator('fr');
    expect(t.locale).toBe('fr');
  });
});

describe('defaultUiContext', () => {
  test('builds the ambient defaults from the framework primitives', () => {
    const ctx = defaultUiContext();
    expect(ctx.theme).toBe('light');
    expect(ctx.locale).toBe(UI_DEFAULT_LOCALE);
    expect(ctx.timeZone).toBe(UI_DEFAULT_TIME_ZONE);
    expect(ctx.currency).toBe(UI_DEFAULT_CURRENCY);
    expect(ctx.dir).toBe(directionOf(UI_DEFAULT_LOCALE));
    expect(isMiss(ctx.t('some.unknown.key'))).toBe(true);
  });
});

describe('ambientUiContext', () => {
  const locales = localeConfig();
  const time = timeConfig();

  afterEach(() => {
    configureLocales(locales);
    configureTime(time);
  });

  // The failure this exists to prevent: a server render that silently formats every date in UTC
  // and every string in English because it read a constant instead of the request.
  test('takes locale, direction and zone from the framework ambient answers', () => {
    configureLocales({ fallback: 'ar' as Locale });
    configureTime({ defaultZone: 'Asia/Tokyo' as TimeZone });

    const ctx = ambientUiContext();
    expect(ctx.locale).toBe('ar' as Locale);
    expect(ctx.dir).toBe('rtl');
    expect(ctx.timeZone).toBe('Asia/Tokyo' as TimeZone);
    expect(ctx.t.locale).toBe('ar' as Locale);
  });

  // The request beats the process default, or `ambientUiContext()` is a constant with extra
  // steps: `currentTimeZone()` used to read a context field the HTTP pipeline never wrote, so
  // every server-rendered date was UTC however the request arrived.
  test('reads the in-flight request, not the configured fallback', () => {
    configureLocales({ fallback: 'en' as Locale });
    configureTime({ defaultZone: 'Europe/Berlin' as TimeZone });

    const ctx = runWithContext(createContext({ locale: 'ar', tz: 'Asia/Tokyo' }), () =>
      ambientUiContext(),
    );

    expect(ctx.timeZone).toBe('Asia/Tokyo' as TimeZone);
    expect(ctx.locale).toBe('ar' as Locale);
    expect(ctx.dir).toBe('rtl');
  });

  test('falls back to the package defaults with nothing configured and no request', () => {
    const ctx = ambientUiContext();
    expect(ctx.locale).toBe(UI_DEFAULT_LOCALE);
    expect(ctx.timeZone).toBe(UI_DEFAULT_TIME_ZONE);
    expect(ctx.currency).toBe(UI_DEFAULT_CURRENCY);
    expect(ctx.theme).toBe('light');
  });
});

describe('uiContext', () => {
  beforeEach(() => {
    clearSolidRuntime();
  });

  afterEach(() => {
    clearSolidRuntime();
  });

  test('builds against the inert runtime when none is registered, rather than throwing', () => {
    const context = uiContext();
    expect(context.defaultValue.locale).toBe(UI_DEFAULT_LOCALE);
    expect(uiContext()).toBe(context);
  });

  test('throws a runtime-missing error in a DOM with no runtime registered', () => {
    let caught: unknown;
    withDom(() => {
      try {
        uiContext();
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
  });

  test('creates the context via the registered runtime, caching it across calls', () => {
    let calls = 0;
    let receivedDefault: UiContextValue | undefined;
    const runtime = fakeRuntime({
      createContext: <T>(defaultValue: T): SolidContext<T> => {
        calls += 1;
        receivedDefault = defaultValue as unknown as UiContextValue;
        return { id: Symbol(), defaultValue, Provider: () => null as never };
      },
    });
    setSolidRuntime(runtime);

    const first = uiContext();
    const second = uiContext();

    expect(calls).toBe(1);
    expect(first).toBe(second);
    // `t` is a freshly-built translator function each call, so compare it
    // separately from the plain-data fields (a function fails `toEqual`).
    const { t, ...rest } = receivedDefault as UiContextValue;
    const { t: _defaultT, ...defaultRest } = defaultUiContext();
    expect(rest).toEqual(defaultRest);
    expect(typeof t).toBe('function');
    expect(isMiss(t('some.unknown.key'))).toBe(true);
  });

  test('a replaced runtime rebuilds the context instead of handing back the old one', () => {
    setSolidRuntime(fakeRuntime());
    const first = uiContext();
    setSolidRuntime(fakeRuntime());
    expect(uiContext()).not.toBe(first);
  });

  test('clearing the runtime rebuilds against the inert one, whatever ran before it', () => {
    setSolidRuntime(fakeRuntime());
    const first = uiContext();
    clearSolidRuntime();
    expect(uiContext()).not.toBe(first);
  });
});

describe('useUi', () => {
  beforeEach(() => {
    clearSolidRuntime();
  });

  afterEach(() => {
    clearSolidRuntime();
  });

  test('delegates to solid().useContext(uiContext()), returning exactly what it returns', () => {
    const sentinel: UiContextValue = {
      ...defaultUiContext(),
      theme: 'dark',
    };
    let receivedContext: SolidContext<UiContextValue> | undefined;
    const runtime = fakeRuntime({
      useContext: <T>(context: SolidContext<T>): T => {
        receivedContext = context as unknown as SolidContext<UiContextValue>;
        return sentinel as unknown as T;
      },
    });
    setSolidRuntime(runtime);

    const expectedContext = uiContext();
    const result = useUi();

    expect(result).toBe(sentinel);
    expect(receivedContext).toBe(expectedContext);
  });
});
