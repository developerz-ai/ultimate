/**
 * The minimal client router. Vendored on purpose: the router is load-bearing for every
 * app page, and a moving SolidStart alpha is not something a framework should depend on.
 *
 * No `solid-js` import — reactive primitives and the DOM are injected, so this file runs
 * under `bun test` with no DOM and no framework runtime.
 */

import type { CompiledPattern } from './registry';
import { compilePattern } from './registry';
import type { RouteParams } from './route';

export interface RouterRoute {
  readonly path: string;
  /** Module URL for the route chunk; used by `prefetch`. */
  readonly chunk?: string;
}

export interface ResolvedRoute {
  readonly route: RouterRoute;
  readonly params: RouteParams;
  readonly pathname: string;
  readonly search: string;
}

/** Injected instead of imported so there is no framework runtime dependency here. */
export interface ReactivePrimitives {
  createSignal<T>(initial: T): readonly [() => T, (next: T) => void];
}

export interface RouterHost {
  readonly pathname: () => string;
  readonly search: () => string;
  readonly pushState: (url: string) => void;
  readonly replaceState: (url: string) => void;
  readonly onPopState: (handler: () => void) => void;
  readonly scrollTo: (x: number, y: number) => void;
  readonly scrollY: () => number;
  /** `document.startViewTransition` when present; falls back to running the update. */
  readonly viewTransition?: (update: () => void) => void;
  /** Warm a chunk. Defaults to a no-op host in tests. */
  readonly preload?: (chunk: string) => void;
}

export type NavigationGuard = (
  to: ResolvedRoute,
  from: ResolvedRoute | null,
) => boolean | Promise<boolean>;

export interface RouterOptions {
  readonly routes: readonly RouterRoute[];
  readonly host: RouterHost;
  readonly primitives: ReactivePrimitives;
  /** Hover dwell before prefetching, ms. */
  readonly prefetchDelayMs?: number;
}

export interface NavigateOptions {
  readonly replace?: boolean;
  readonly scroll?: boolean;
}

export interface Router {
  readonly current: () => ResolvedRoute | null;
  readonly navigate: (to: string, options?: NavigateOptions) => Promise<boolean>;
  readonly resolve: (url: string) => ResolvedRoute | null;
  readonly prefetch: (to: string) => void;
  readonly guard: (guard: NavigationGuard) => () => void;
  /** Attach hover/visible prefetch + scroll restoration to a container element. */
  readonly attach: (container: PrefetchContainer) => () => void;
}

/** Structural view of the DOM bits the router touches, so tests can fake them. */
export type DomEventHandler = (event: { target: unknown }) => void;

export interface PrefetchContainer {
  querySelectorAll(selector: string): Iterable<PrefetchLink>;
  addEventListener(type: string, handler: DomEventHandler, options?: unknown): void;
  removeEventListener(type: string, handler: DomEventHandler, options?: unknown): void;
}

export interface PrefetchLink {
  getAttribute(name: string): string | null;
}

interface CompiledRoute {
  readonly route: RouterRoute;
  readonly pattern: CompiledPattern;
}

export function createRouter(options: RouterOptions): Router {
  const compiled: readonly CompiledRoute[] = options.routes
    .map((route) => ({ route, pattern: compilePattern(route.path) }))
    .sort((a, b) => b.pattern.specificity - a.pattern.specificity);

  const guards = new Set<NavigationGuard>();
  const scrollPositions = new Map<string, number>();
  const prefetched = new Set<string>();
  const host = options.host;

  const [current, setCurrent] = options.primitives.createSignal<ResolvedRoute | null>(
    resolve(`${host.pathname()}${host.search()}`),
  );

  function resolve(url: string): ResolvedRoute | null {
    const [rawPath = '/', rawSearch = ''] = splitUrl(url);
    for (const candidate of compiled) {
      const match = candidate.pattern.regex.exec(rawPath);
      if (match === null) continue;
      const params: Record<string, string> = {};
      candidate.pattern.keys.forEach((key, index) => {
        const value = match[index + 1];
        if (value !== undefined) params[key] = decodeURIComponent(value);
      });
      return {
        route: candidate.route,
        params,
        pathname: rawPath,
        search: rawSearch === '' ? '' : `?${rawSearch}`,
      };
    }
    return null;
  }

  async function navigate(to: string, navOptions: NavigateOptions = {}): Promise<boolean> {
    const next = resolve(to);
    if (next === null) return false;

    const from = current();
    for (const guard of guards) {
      // A guard that says no is a hard stop: no history entry, no scroll change.
      if (!(await guard(next, from))) return false;
    }

    if (from !== null) scrollPositions.set(keyOf(from), host.scrollY());

    const commit = (): void => {
      if (navOptions.replace === true) host.replaceState(to);
      else host.pushState(to);
      setCurrent(next);
      if (navOptions.scroll !== false) restoreScroll(next);
    };

    if (host.viewTransition !== undefined) host.viewTransition(commit);
    else commit();
    return true;
  }

  function restoreScroll(route: ResolvedRoute): void {
    host.scrollTo(0, scrollPositions.get(keyOf(route)) ?? 0);
  }

  function prefetch(to: string): void {
    const target = resolve(to);
    const chunk = target?.route.chunk;
    if (chunk === undefined || prefetched.has(chunk)) return;
    prefetched.add(chunk);
    host.preload?.(chunk);
  }

  host.onPopState(() => {
    const next = resolve(`${host.pathname()}${host.search()}`);
    if (next !== null) {
      setCurrent(next);
      restoreScroll(next);
    }
  });

  return {
    current,
    navigate,
    resolve,
    prefetch,
    guard(guard) {
      guards.add(guard);
      return () => guards.delete(guard);
    },
    attach(container) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onEnter = (event: { target: unknown }): void => {
        const href = hrefOf(event.target);
        if (href === null) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => prefetch(href), options.prefetchDelayMs ?? 80);
      };
      const onLeave = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };

      container.addEventListener('mouseenter', onEnter, true);
      container.addEventListener('mouseleave', onLeave, true);

      // Visible prefetch: everything explicitly marked, warmed once it is on screen.
      for (const link of container.querySelectorAll('a[data-prefetch="visible"]')) {
        const href = link.getAttribute('href');
        if (href !== null) prefetch(href);
      }

      return () => {
        container.removeEventListener('mouseenter', onEnter, true);
        container.removeEventListener('mouseleave', onLeave, true);
        onLeave();
      };
    },
  };
}

function keyOf(route: ResolvedRoute): string {
  return `${route.pathname}${route.search}`;
}

function splitUrl(url: string): readonly [string, string] {
  const hashless = url.split('#')[0] ?? '/';
  const index = hashless.indexOf('?');
  if (index === -1) return [hashless === '' ? '/' : hashless, ''];
  return [hashless.slice(0, index) || '/', hashless.slice(index + 1)];
}

function hrefOf(target: unknown): string | null {
  if (typeof target !== 'object' || target === null) return null;
  if (!('getAttribute' in target)) return null;
  const link = target as PrefetchLink;
  return link.getAttribute('href');
}
