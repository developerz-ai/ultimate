// `UiProvider` is the one component in this package that is client-only, so everything below it —
// the value it publishes and the `lang`/`dir` it reflects onto <html> — is unreachable on the inert
// path `inert-render.test.ts` covers. This file registers a runtime that behaves the way Solid does
// in the two ways the component depends on: a memo is re-read per use, and effects run after the
// tree exists rather than during it.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Locale, Translator } from '@ultimat3/i18n';
import type { TimeZone } from '@ultimat3/time';
import { UI_ERROR_CODES } from '../errors';
import { probe, renderNodes, unprobe } from '../jsx-probe';
import type { UiContextValue } from './context';
import { UI_DEFAULT_CURRENCY, UI_DEFAULT_LOCALE, UI_DEFAULT_TIME_ZONE } from './context';
import { UiProvider } from './provider';
import type { SolidContext, SolidRuntime } from './solid-adapter';
import { clearSolidRuntime, setSolidRuntime } from './solid-adapter';

interface Harness {
  /** Effects queued during the render, run in order once the tree exists. */
  flush(): void;
  /** The value handed to the context Provider. */
  readonly published: UiContextValue[];
  readonly attributes: string[];
  restore(): void;
}

/**
 * A runtime, a document, and a probe — installed together and torn down together. Nothing here
 * re-implements what the component decides: the fake context Provider records the value it is
 * handed and renders its children, and the fake document records the attributes it is given.
 */
function harness(withDocument = true): Harness {
  const effects: (() => void)[] = [];
  const published: UiContextValue[] = [];
  const attributes: string[] = [];

  const runtime: SolidRuntime = {
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol('test.context'),
      defaultValue,
      Provider: (props: { value: T; children?: unknown }) => {
        published.push(props.value as UiContextValue);
        return props.children as never;
      },
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      return [
        (): T => current,
        (next: T): void => {
          current = next;
        },
      ] as [() => T, (next: T) => void];
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: (fn: () => void): void => {
      effects.push(fn);
    },
    onCleanup: (): void => undefined,
  };

  setSolidRuntime(runtime);
  probe();
  const hadDocument = 'document' in globalThis;
  if (withDocument) {
    Object.assign(globalThis, {
      document: {
        documentElement: {
          setAttribute: (name: string, value: string): void => {
            attributes.push(`${name}=${value}`);
          },
        },
      },
    });
  }

  return {
    published,
    attributes,
    flush(): void {
      for (const effect of effects.splice(0)) effect();
    },
    restore(): void {
      if (!hadDocument) Reflect.deleteProperty(globalThis, 'document');
      unprobe();
      clearSolidRuntime();
    },
  };
}

describe('UiProvider', () => {
  afterEach(clearSolidRuntime);

  test('refuses to render without a runtime, rather than dropping the values it was given', () => {
    let thrown: unknown;
    try {
      renderNodes(UiProvider, { locale: 'ar' as Locale, children: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
    expect((thrown as { fix: string }).fix).toContain('useUi()');
  });

  test('publishes every field of the context, defaulted where the app said nothing', () => {
    const h = harness();
    try {
      renderNodes(UiProvider, { children: 'body' });

      expect(h.published).toHaveLength(1);
      expect(h.published[0]).toMatchObject({
        theme: 'light',
        locale: UI_DEFAULT_LOCALE,
        timeZone: UI_DEFAULT_TIME_ZONE,
        currency: UI_DEFAULT_CURRENCY,
        dir: 'ltr',
      });
      expect(typeof h.published[0]?.t).toBe('function');
    } finally {
      h.restore();
    }
  });

  test('the direction is derived from the locale, never taken as a prop', () => {
    const h = harness();
    try {
      renderNodes(UiProvider, { locale: 'ar' as Locale, children: null });
      expect(h.published[0]?.dir).toBe('rtl');
      expect(h.published[0]?.locale).toBe('ar');
    } finally {
      h.restore();
    }
  });

  test('the app’s own translator is published verbatim, not wrapped in the fallback', () => {
    const h = harness();
    const t = ((key: string) => `[${key}]`) as unknown as Translator;
    try {
      renderNodes(UiProvider, {
        t,
        currency: 'EUR',
        timeZone: 'Europe/Berlin' as TimeZone,
        theme: 'dark',
        children: null,
      });
      expect(h.published[0]?.t).toBe(t);
      expect(h.published[0]?.currency).toBe('EUR');
      expect(h.published[0]?.timeZone).toBe('Europe/Berlin');
      expect(h.published[0]?.theme).toBe('dark');
    } finally {
      h.restore();
    }
  });

  test('reflects lang and dir onto <html>, so native controls agree with the locale', () => {
    const h = harness();
    try {
      renderNodes(UiProvider, { locale: 'ar' as Locale, children: null });
      // Before the effect runs nothing has touched the document — this is DOM work, not render.
      expect(h.attributes).toEqual([]);

      h.flush();
      expect(h.attributes).toEqual(['lang=ar', 'dir=rtl']);
    } finally {
      h.restore();
    }
  });

  test('writes data-theme only when the app chose one — otherwise the head script owns it', () => {
    const h = harness();
    try {
      renderNodes(UiProvider, { theme: 'dark', children: null });
      h.flush();
      expect(h.attributes).toEqual(['lang=en', 'dir=ltr', 'data-theme=dark']);
    } finally {
      h.restore();
    }
  });

  test('with no document the effect is a no-op instead of throwing on the server', () => {
    const h = harness(false);
    try {
      renderNodes(UiProvider, { children: null });
      expect(() => h.flush()).not.toThrow();
      expect(h.attributes).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test('the children are rendered under the provider, not replaced by it', () => {
    const h = harness();
    try {
      const nodes = renderNodes(UiProvider, { children: { inert: true, type: 'main', props: {} } });
      expect(nodes.map((node) => node.type)).toEqual(['main']);
    } finally {
      h.restore();
    }
  });
});
