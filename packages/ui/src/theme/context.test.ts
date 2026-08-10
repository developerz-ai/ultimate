// The ambient UI context: default values, the loud-miss fallback translator,
// and lazy Solid-context creation/caching behind the injected runtime.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { directionOf, isMiss } from '@ultimat3/i18n';
import { UI_ERROR_CODES } from '../errors';
import {
  defaultUiContext,
  fallbackTranslator,
  UI_DEFAULT_CURRENCY,
  UI_DEFAULT_LOCALE,
  UI_DEFAULT_TIME_ZONE,
  type UiContextValue,
  uiContext,
  useUi,
} from './context';
import {
  clearSolidRuntime,
  type SolidContext,
  type SolidRuntime,
  setSolidRuntime,
} from './solid-adapter';

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

describe('uiContext', () => {
  beforeEach(() => {
    clearSolidRuntime();
  });

  afterEach(() => {
    clearSolidRuntime();
  });

  test('throws a runtime-missing error when no Solid runtime is registered', () => {
    try {
      uiContext();
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string };
      expect(err.code).toBe(UI_ERROR_CODES.runtimeMissing);
    }
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
