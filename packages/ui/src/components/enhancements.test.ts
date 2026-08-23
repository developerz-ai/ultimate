// Three components that must already work with scripting off, and only then get better with it.
// The enhancement half lives in an effect, which never runs on the inert server path — so the
// observer, the OS-theme subscription and the click interception were all unexercised. A runtime
// that queues effects and runs them after the tree exists is what makes them reachable.

import { afterEach, describe, expect, test } from 'bun:test';
import { UI_KEYS } from '../i18n-keys';
import { byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { SolidContext, SolidRuntime } from '../theme/solid-adapter';
import type { Theme, ThemeEnv } from '../theme/theme';
import { InfiniteScroll } from './InfiniteScroll';
import { ThemeToggle } from './ThemeToggle';

interface Runtime {
  flush(): void;
  cleanup(): void;
  restore(): void;
}

function runtime(): Runtime {
  const effects: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const rt: SolidRuntime = {
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol('test.context'),
      defaultValue,
      Provider: (props: { children?: unknown }) => props.children as never,
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      const set = (next: T): void => {
        current = next;
      };
      return [(): T => current, set] as [() => T, (next: T) => void];
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: (fn: () => void): void => void effects.push(fn),
    onCleanup: (fn: () => void): void => void cleanups.push(fn),
  };
  setSolidRuntime(rt);
  probe();
  return {
    flush: () => {
      for (const effect of effects) effect();
    },
    cleanup: () => {
      for (const fn of cleanups.splice(0)) fn();
    },
    restore: () => {
      unprobe();
      clearSolidRuntime();
    },
  };
}

interface FakeThemeEnv extends ThemeEnv {
  stored: string | null;
  dark: boolean;
  readonly applied: Theme[];
  readonly observers: number[];
  fireOsChange(): void;
}

function themeEnv(stored: string | null = null): FakeThemeEnv {
  const listeners: (() => void)[] = [];
  const env: FakeThemeEnv = {
    stored,
    dark: false,
    applied: [],
    observers: [],
    read: () => env.stored,
    write: (value) => {
      env.stored = value;
    },
    remove: () => {
      env.stored = null;
    },
    prefersDark: () => env.dark,
    apply: (theme) => void env.applied.push(theme),
    observeOs: (listener) => {
      listeners.push(listener);
      env.observers.push(listeners.length);
      return () => void listeners.splice(listeners.indexOf(listener), 1);
    },
    fireOsChange: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  return env;
}

describe('ThemeToggle', () => {
  afterEach(clearSolidRuntime);

  test('the toggle offers the theme it will switch TO, and reports the one in force', () => {
    const rt = runtime();
    try {
      const dark = renderNodes(ThemeToggle, { initial: 'dark', env: themeEnv() });
      const button = one(byTag(dark, 'button'), 'toggle');
      // Announcing the current theme would tell the user what they can already see.
      expect(button.props['aria-label']).toContain(UI_KEYS.themeLight);
      expect(button.props['aria-pressed']).toBe('true');
      expect(one(withAttr(dark, 'data-theme-glyph'), 'glyph').props['data-theme-glyph']).toBe(
        'dark',
      );

      const light = renderNodes(ThemeToggle, { initial: 'light', env: themeEnv() });
      expect(one(byTag(light, 'button'), 'toggle').props['aria-label']).toContain(
        UI_KEYS.themeDark,
      );
      expect(one(byTag(light, 'button'), 'toggle').props['aria-pressed']).toBe('false');
    } finally {
      rt.restore();
    }
  });

  test('clicking flips the resolved theme and records it as an explicit choice', () => {
    const rt = runtime();
    const env = themeEnv();
    try {
      const nodes = renderNodes(ThemeToggle, { initial: 'light', env });
      fire(one(byTag(nodes, 'button'), 'toggle'), 'onClick', {});

      expect(env.stored).toBe('dark');
      expect(env.applied).toEqual(['dark']);
    } finally {
      rt.restore();
    }
  });

  test('the effect syncs from the env and follows the OS until the user chooses', () => {
    const rt = runtime();
    const env = themeEnv();
    try {
      renderNodes(ThemeToggle, { env });
      expect(env.observers).toEqual([]);

      rt.flush();
      expect(env.observers).toEqual([1]);

      env.dark = true;
      env.fireOsChange();
      expect(env.applied).toEqual(['dark']);

      // An explicit choice outranks the OS from then on.
      env.stored = 'light';
      env.applied.length = 0;
      env.fireOsChange();
      expect(env.applied).toEqual([]);
    } finally {
      rt.restore();
    }
  });

  test('cleanup drops the OS subscription instead of leaking it per mount', () => {
    const rt = runtime();
    const env = themeEnv();
    try {
      renderNodes(ThemeToggle, { env });
      rt.flush();
      rt.cleanup();

      env.dark = true;
      env.fireOsChange();
      expect(env.applied).toEqual([]);
    } finally {
      rt.restore();
    }
  });

  test('with no env and no window the effect does nothing, rather than reaching for the DOM', () => {
    const rt = runtime();
    try {
      renderNodes(ThemeToggle, {});
      // `browserThemeEnv()` throws off-DOM; the guard is what keeps a server render alive.
      expect(() => rt.flush()).not.toThrow();
    } finally {
      rt.restore();
    }
  });

  test('select mode offers system, light and dark — every label from the catalog', () => {
    const rt = runtime();
    const env = themeEnv();
    try {
      const nodes = renderNodes(ThemeToggle, { mode: 'select', env });
      const options = byTag(nodes, 'option');

      expect(options.map((node) => node.props['value'])).toEqual(['system', 'light', 'dark']);
      expect(options.map((node) => node.props['children'])).toEqual([
        `⟦${UI_KEYS.themeSystem}⟧`,
        `⟦${UI_KEYS.themeLight}⟧`,
        `⟦${UI_KEYS.themeDark}⟧`,
      ]);
      expect(one(byTag(nodes, 'select'), 'select').props['aria-label']).toBe(`⟦${UI_KEYS.theme}⟧`);
      // With no stored choice, "system" is the one selected.
      expect(withAttr(options, 'selected', true).map((node) => node.props['value'])).toEqual([
        'system',
      ]);
    } finally {
      rt.restore();
    }
  });

  test('picking a theme in select mode persists it; picking system clears the choice', () => {
    const rt = runtime();
    const env = themeEnv();
    try {
      const nodes = renderNodes(ThemeToggle, { mode: 'select', env });
      const select = one(byTag(nodes, 'select'), 'select');

      fire(select, 'onChange', { currentTarget: { value: 'dark' } });
      expect(env.stored).toBe('dark');
      expect(env.applied).toEqual(['dark']);

      fire(select, 'onChange', { currentTarget: { value: 'system' } });
      // Cleared, and the OS answer applied in its place.
      expect(env.stored).toBeNull();
      expect(env.applied).toEqual(['dark', 'light']);
    } finally {
      rt.restore();
    }
  });
});

describe('InfiniteScroll', () => {
  afterEach(clearSolidRuntime);

  interface FakeObserver {
    readonly observed: unknown[];
    disconnected: number;
    fire(intersecting: boolean): void;
  }

  interface Observers {
    /** The last observer the component constructed, or `undefined` if it constructed none. */
    last(): FakeObserver | undefined;
    /** The `rootMargin` each construction was given, in order. */
    readonly margins: (string | undefined)[];
  }

  /** Installs a global `IntersectionObserver` for one body, and always removes it again. */
  function withObserver<T>(body: (observers: Observers) => T): T {
    let last: FakeObserver | undefined;
    const margins: (string | undefined)[] = [];
    const hadObserver = 'IntersectionObserver' in globalThis;
    const previous: unknown = Reflect.get(globalThis, 'IntersectionObserver');

    class Fake {
      readonly observed: unknown[] = [];
      disconnected = 0;
      constructor(
        private readonly callback: (entries: { isIntersecting: boolean }[]) => void,
        options: { rootMargin?: string },
      ) {
        margins.push(options.rootMargin);
        last = this as unknown as FakeObserver;
      }
      observe(target: unknown): void {
        this.observed.push(target);
      }
      disconnect(): void {
        this.disconnected += 1;
      }
      fire(intersecting: boolean): void {
        this.callback([{ isIntersecting: intersecting }]);
      }
    }

    Object.assign(globalThis, { IntersectionObserver: Fake });
    try {
      return body({ last: () => last, margins });
    } finally {
      if (hadObserver) Object.assign(globalThis, { IntersectionObserver: previous });
      else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    }
  }

  test('the foot is a real rel="next" link, which is the whole no-JS path', () => {
    const rt = runtime();
    try {
      const link = one(
        byTag(
          renderNodes(InfiniteScroll, { children: 'rows', hasMore: true, nextHref: '?p=2' }),
          'a',
        ),
        'load-more link',
      );
      expect(link.props['href']).toBe('?p=2');
      expect(link.props['rel']).toBe('next');
      expect(link.props['children']).toBe(`⟦${UI_KEYS.loadMore}⟧`);
    } finally {
      rt.restore();
    }
  });

  test('the end of the list is announced once there is no next page', () => {
    const rt = runtime();
    try {
      const nodes = renderNodes(InfiniteScroll, { children: 'rows', hasMore: false });
      const end = one(byTag(nodes, 'p'), 'end-of-list');
      expect(end.props['role']).toBe('status');
      expect(end.props['children']).toBe(`⟦${UI_KEYS.endOfList}⟧`);
      expect(byTag(nodes, 'a')).toEqual([]);
    } finally {
      rt.restore();
    }
  });

  test('a page in flight reports busy and offers no second request', () => {
    const rt = runtime();
    try {
      const nodes = renderNodes(InfiniteScroll, {
        children: 'rows',
        hasMore: true,
        nextHref: '?p=2',
        loading: true,
      });
      expect(nodes[0]?.props['aria-busy']).toBe('true');
      expect(byTag(nodes, 'a')).toEqual([]);
    } finally {
      rt.restore();
    }
  });

  test('with a handler the link click is intercepted instead of navigating', () => {
    const rt = runtime();
    try {
      let loads = 0;
      let prevented = 0;
      const nodes = renderNodes(InfiniteScroll, {
        children: 'rows',
        hasMore: true,
        nextHref: '?p=2',
        onLoadMore: () => (loads += 1),
      });
      fire(one(byTag(nodes, 'a'), 'link'), 'onClick', {
        preventDefault: () => (prevented += 1),
      });
      expect([loads, prevented]).toEqual([1, 1]);
    } finally {
      rt.restore();
    }
  });

  test('with no handler the click is left alone, so the browser follows the link', () => {
    const rt = runtime();
    try {
      let prevented = 0;
      const nodes = renderNodes(InfiniteScroll, {
        children: 'rows',
        hasMore: true,
        nextHref: '?p=2',
      });
      fire(one(byTag(nodes, 'a'), 'link'), 'onClick', {
        preventDefault: () => (prevented += 1),
      });
      expect(prevented).toBe(0);
    } finally {
      rt.restore();
    }
  });

  test('the sentinel asks for the next page before the reader reaches the end', () => {
    const rt = runtime();
    withObserver(({ last, margins }) => {
      try {
        let loads = 0;
        const nodes = renderNodes(InfiniteScroll, {
          children: 'rows',
          hasMore: true,
          nextHref: '?p=2',
          rootMargin: '900px',
          onLoadMore: () => (loads += 1),
        });
        const sentinel = { tag: 'sentinel' };
        (
          one(withAttr(nodes, 'aria-hidden', 'true'), 'sentinel').props['ref'] as (
            el: unknown,
          ) => void
        )(sentinel);

        rt.flush();
        expect(last()?.observed).toEqual([sentinel]);
        expect(margins).toEqual(['900px']);

        last()?.fire(false);
        expect(loads).toBe(0);
        last()?.fire(true);
        expect(loads).toBe(1);

        rt.cleanup();
        expect(last()?.disconnected).toBe(1);
      } finally {
        rt.restore();
      }
    });
  });

  test('a page already in flight is not asked for a second time', () => {
    const rt = runtime();
    withObserver(({ last, margins }) => {
      try {
        let loads = 0;
        const nodes = renderNodes(InfiniteScroll, {
          children: 'rows',
          hasMore: true,
          nextHref: '?p=2',
          loading: true,
          onLoadMore: () => (loads += 1),
        });
        (
          one(withAttr(nodes, 'aria-hidden', 'true'), 'sentinel').props['ref'] as (
            el: unknown,
          ) => void
        )({});
        rt.flush();
        expect(margins).toEqual(['400px']);

        last()?.fire(true);
        expect(loads).toBe(0);
      } finally {
        rt.restore();
      }
    });
  });

  test('no last page, no handler, and no observer each mean no enhancement at all', () => {
    const rt = runtime();
    withObserver(({ last }) => {
      try {
        for (const props of [
          { children: 'rows', hasMore: false, onLoadMore: (): void => undefined },
          { children: 'rows', hasMore: true, nextHref: '?p=2' },
        ]) {
          const nodes = renderNodes(InfiniteScroll, props);
          (
            one(withAttr(nodes, 'aria-hidden', 'true'), 'sentinel').props['ref'] as (
              el: unknown,
            ) => void
          )({});
          rt.flush();
        }
        expect(last()).toBeUndefined();
      } finally {
        rt.restore();
      }
    });
  });
});
