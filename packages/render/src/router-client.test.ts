/**
 * Covers the vendored client router: route resolution, navigation, guards,
 * scroll restoration, view transitions, prefetch (hover/visible), and popstate —
 * all through fake `ReactivePrimitives`/`RouterHost`, no solid-js and no DOM.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  DomEventHandler,
  PrefetchContainer,
  PrefetchLink,
  ReactivePrimitives,
  Router,
  RouterHost,
  RouterRoute,
} from './router-client';
import { createRouter } from './router-client';

function fakeSignal<T>(initial: T): readonly [() => T, (next: T) => void] {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ] as const;
}

const primitives: ReactivePrimitives = {
  createSignal: fakeSignal,
};

interface FakeHost extends RouterHost {
  readonly pushed: string[];
  readonly replaced: string[];
  readonly scrolls: readonly (readonly [number, number])[];
  setPath(pathname: string, search?: string): void;
  setScrollY(y: number): void;
  firePopState(): void;
}

function createFakeHost(initialPath = '/', initialSearch = ''): FakeHost {
  let pathname = initialPath;
  let search = initialSearch;
  let scrollY = 0;
  const pushed: string[] = [];
  const replaced: string[] = [];
  const scrolls: (readonly [number, number])[] = [];
  let popHandler: (() => void) | null = null;

  return {
    pathname: () => pathname,
    search: () => search,
    pushState(url: string) {
      pushed.push(url);
    },
    replaceState(url: string) {
      replaced.push(url);
    },
    onPopState(handler: () => void) {
      popHandler = handler;
    },
    scrollTo(x: number, y: number) {
      scrolls.push([x, y]);
    },
    scrollY: () => scrollY,
    pushed,
    replaced,
    scrolls,
    setPath(nextPath: string, nextSearch = '') {
      pathname = nextPath;
      search = nextSearch;
    },
    setScrollY(y: number) {
      scrollY = y;
    },
    firePopState() {
      popHandler?.();
    },
  };
}

function fakeLink(href: string | null): PrefetchLink {
  return {
    getAttribute: (name: string) => (name === 'href' ? href : null),
  };
}

interface FakeContainer extends PrefetchContainer {
  readonly listeners: Map<string, { handler: DomEventHandler; capture: unknown }>;
  readonly removed: Map<string, { handler: DomEventHandler; capture: unknown }>;
  visible: readonly PrefetchLink[];
}

function createFakeContainer(visible: readonly PrefetchLink[] = []): FakeContainer {
  const listeners = new Map<string, { handler: DomEventHandler; capture: unknown }>();
  const removed = new Map<string, { handler: DomEventHandler; capture: unknown }>();
  return {
    listeners,
    removed,
    visible,
    querySelectorAll(selector: string): Iterable<PrefetchLink> {
      return selector === 'a[data-prefetch="visible"]' ? this.visible : [];
    },
    addEventListener(type: string, handler: DomEventHandler, options?: unknown) {
      listeners.set(type, { handler, capture: options });
    },
    removeEventListener(type: string, handler: DomEventHandler, options?: unknown) {
      removed.set(type, { handler, capture: options });
    },
  };
}

const routes: readonly RouterRoute[] = [
  { path: '/', chunk: 'home.js' },
  { path: '/blog/:slug', chunk: 'blog-post.js' },
  { path: '/blog/feed', chunk: 'blog-feed.js' },
  { path: '/no-chunk' },
];

let host: FakeHost;
let router: Router;

beforeEach(() => {
  host = createFakeHost('/');
  router = createRouter({ routes, host, primitives });
});

describe('resolve', () => {
  test('matches a static route and returns empty params', () => {
    const resolved = router.resolve('/blog/feed');
    expect(resolved?.route.path).toBe('/blog/feed');
    expect(resolved?.params).toEqual({});
  });

  test('matches a dynamic route and extracts + URL-decodes params', () => {
    const resolved = router.resolve('/blog/hello%20world');
    expect(resolved?.route.path).toBe('/blog/:slug');
    expect(resolved?.params).toEqual({ slug: 'hello world' });
  });

  test('the more specific static route wins over a dynamic sibling', () => {
    const resolved = router.resolve('/blog/feed');
    expect(resolved?.route.path).toBe('/blog/feed');
  });

  test('splits pathname from search, preserving the leading ?', () => {
    const resolved = router.resolve('/blog/feed?x=1');
    expect(resolved?.pathname).toBe('/blog/feed');
    expect(resolved?.search).toBe('?x=1');
  });

  test('strips the hash fragment and keeps the search', () => {
    const resolved = router.resolve('/blog/a?x=1#frag');
    expect(resolved?.pathname).toBe('/blog/a');
    expect(resolved?.search).toBe('?x=1');
  });

  test('empty path variants resolve like the root route', () => {
    expect(router.resolve('')?.route.path).toBe('/');
    expect(router.resolve('?x=1')?.route.path).toBe('/');
  });

  test('returns null for an unmatched url', () => {
    expect(router.resolve('/does-not-exist')).toBe(null);
  });

  test('current() reflects the initial host pathname/search on creation', () => {
    const initialHost = createFakeHost('/blog/feed', '?ref=home');
    const initialRouter = createRouter({ routes, host: initialHost, primitives });
    expect(initialRouter.current()?.route.path).toBe('/blog/feed');
    expect(initialRouter.current()?.search).toBe('?ref=home');
  });
});

describe('navigate', () => {
  test('updates current() and calls pushState by default', async () => {
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(true);
    expect(router.current()?.route.path).toBe('/blog/feed');
    expect(host.pushed).toEqual(['/blog/feed']);
    expect(host.replaced).toEqual([]);
  });

  test('calls replaceState instead of pushState when { replace: true }', async () => {
    await router.navigate('/blog/feed', { replace: true });
    expect(host.pushed).toEqual([]);
    expect(host.replaced).toEqual(['/blog/feed']);
  });

  test('records the outgoing route scroll position before navigating away', async () => {
    host.setScrollY(240);
    await router.navigate('/blog/feed');
    host.setScrollY(10);
    await router.navigate('/blog/other');
    // Navigating back to '/' restores the scroll recorded when we left it, back in the first hop.
    await router.navigate('/');
    expect(host.scrolls.at(-1)).toEqual([0, 240]);
  });

  test('restores the recorded scroll position when returning to a visited route', async () => {
    // Start at '/', scroll to 100, then leave — '/' scroll position (100) is recorded.
    host.setScrollY(100);
    await router.navigate('/blog/feed');
    host.setScrollY(0);
    await router.navigate('/');
    expect(host.scrolls.at(-1)).toEqual([0, 100]);
  });

  test('defaults to scroll 0 for a route never visited before', async () => {
    await router.navigate('/blog/feed');
    expect(host.scrolls.at(-1)).toEqual([0, 0]);
  });

  test('{ scroll: false } skips the restore call entirely', async () => {
    host.setScrollY(50);
    await router.navigate('/blog/feed', { scroll: false });
    expect(host.scrolls).toEqual([]);
  });

  test('navigating to an unresolvable url returns false and changes nothing', async () => {
    const ok = await router.navigate('/nope');
    expect(ok).toBe(false);
    expect(router.current()?.route.path).toBe('/');
    expect(host.pushed).toEqual([]);
    expect(host.replaced).toEqual([]);
  });
});

describe('guards', () => {
  test('a guard returning false blocks navigation with no history entry or scroll change', async () => {
    router.guard(() => false);
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(false);
    expect(router.current()?.route.path).toBe('/');
    expect(host.pushed).toEqual([]);
    expect(host.scrolls).toEqual([]);
  });

  test('a guard resolving to false (async) blocks navigation', async () => {
    router.guard(async () => Promise.resolve(false));
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(false);
  });

  test('a guard returning true lets navigation through', async () => {
    router.guard(() => true);
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(true);
    expect(router.current()?.route.path).toBe('/blog/feed');
  });

  test('all guards must pass; one veto is enough to block', async () => {
    router.guard(() => true);
    router.guard(() => false);
    router.guard(() => true);
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(false);
  });

  test('unsubscribing a guard removes it from consultation', async () => {
    const unsubscribe = router.guard(() => false);
    unsubscribe();
    const ok = await router.navigate('/blog/feed');
    expect(ok).toBe(true);
  });
});

describe('viewTransition', () => {
  test('when host.viewTransition is provided, navigate defers commit to it', async () => {
    const calls: Array<() => void> = [];
    const vtHost = createFakeHost('/');
    const vtRouter = createRouter({
      routes,
      host: { ...vtHost, viewTransition: (update) => calls.push(update) },
      primitives,
    });

    const ok = await vtRouter.navigate('/blog/feed');
    expect(ok).toBe(true);
    // The commit was handed to viewTransition, not run inline yet.
    expect(vtRouter.current()?.route.path).toBe('/');
    expect(vtHost.pushed).toEqual([]);

    expect(calls).toHaveLength(1);
    calls[0]?.();
    expect(vtRouter.current()?.route.path).toBe('/blog/feed');
    expect(vtHost.pushed).toEqual(['/blog/feed']);
  });
});

describe('prefetch', () => {
  test('calls host.preload with the resolved route chunk', () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
    });

    preloadRouter.prefetch('/blog/feed');
    expect(preloaded).toEqual(['blog-feed.js']);
  });

  test('dedups repeated prefetches of the same chunk', () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
    });

    preloadRouter.prefetch('/blog/feed');
    preloadRouter.prefetch('/blog/feed');
    preloadRouter.prefetch('/blog/feed');
    expect(preloaded).toEqual(['blog-feed.js']);
  });

  test('a route with no chunk is a no-op', () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
    });

    expect(() => preloadRouter.prefetch('/no-chunk')).not.toThrow();
    expect(preloaded).toEqual([]);
  });

  test('an unresolvable url is a no-op', () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
    });

    expect(() => preloadRouter.prefetch('/nope')).not.toThrow();
    expect(preloaded).toEqual([]);
  });
});

describe('attach', () => {
  test('wires mouseenter/mouseleave in the capture phase', () => {
    const container = createFakeContainer();
    router.attach(container);
    expect(container.listeners.get('mouseenter')?.capture).toBe(true);
    expect(container.listeners.get('mouseleave')?.capture).toBe(true);
  });

  test('prefetches links marked data-prefetch="visible" immediately on attach', () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
    });
    const container = createFakeContainer([fakeLink('/blog/feed')]);

    preloadRouter.attach(container);
    expect(preloaded).toEqual(['blog-feed.js']);
  });

  test('hovering a link past the dwell delay triggers a prefetch', async () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
      prefetchDelayMs: 5,
    });
    const container = createFakeContainer();
    preloadRouter.attach(container);

    const onEnter = container.listeners.get('mouseenter')?.handler;
    onEnter?.({ target: fakeLink('/blog/feed') });
    expect(preloaded).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preloaded).toEqual(['blog-feed.js']);
  });

  test('mouseleave before the dwell cancels the pending prefetch', async () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
      prefetchDelayMs: 5,
    });
    const container = createFakeContainer();
    preloadRouter.attach(container);

    const onEnter = container.listeners.get('mouseenter')?.handler;
    const onLeave = container.listeners.get('mouseleave')?.handler;
    onEnter?.({ target: fakeLink('/blog/feed') });
    onLeave?.({ target: undefined });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preloaded).toEqual([]);
  });

  test('a target with no getAttribute is handled without throwing', () => {
    const container = createFakeContainer();
    router.attach(container);
    const onEnter = container.listeners.get('mouseenter')?.handler;
    expect(() => onEnter?.({ target: {} })).not.toThrow();
    expect(() => onEnter?.({ target: null })).not.toThrow();
  });

  test('detach removes both listeners and clears a pending timer', async () => {
    const preloaded: string[] = [];
    const preloadHost = createFakeHost('/');
    const preloadRouter = createRouter({
      routes,
      host: { ...preloadHost, preload: (chunk) => preloaded.push(chunk) },
      primitives,
      prefetchDelayMs: 5,
    });
    const container = createFakeContainer();
    const detach = preloadRouter.attach(container);

    const onEnter = container.listeners.get('mouseenter')?.handler;
    onEnter?.({ target: fakeLink('/blog/feed') });
    detach();

    expect(container.removed.get('mouseenter')?.capture).toBe(true);
    expect(container.removed.get('mouseleave')?.capture).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The pending timer was cleared by detach, so the hover never resolves into a prefetch.
    expect(preloaded).toEqual([]);
  });
});

describe('popstate', () => {
  test('a browser back/forward navigation updates current() and restores scroll', () => {
    host.setPath('/blog/feed');
    host.firePopState();
    expect(router.current()?.route.path).toBe('/blog/feed');
    expect(host.scrolls.at(-1)).toEqual([0, 0]);
  });

  test('an unresolvable popstate url leaves current() untouched', () => {
    host.setPath('/nope');
    host.firePopState();
    expect(router.current()?.route.path).toBe('/');
  });
});
