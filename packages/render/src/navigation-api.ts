/**
 * Navigating from code: the client router's public face for an island or an app script —
 * `navigate`, `refresh`, `openModal`, `closeModal`.
 *
 * Each goes through the router when the page carries one (`window.__xNavigation`, started by
 * `@ultimat3/render/navigation`), and falls back to what the browser does without it — so the same
 * call is right on a `site/` page, a `navigation: 'document'` page, or with the router's script
 * blocked. Imports the router's TYPE only: an island that navigates never ships the router.
 */

import type { NavigationRouter } from './navigation';
import { NavigationModalPathInvalidError } from './navigation-errors';
import { modalAddress } from './navigation-modal-rules';

export interface NavigateToOptions {
  /** Replace the current history entry instead of pushing one (`location.replace` without the router). */
  readonly replace?: boolean;
}

interface NavigationWindow {
  readonly location: Location;
  readonly __xNavigation?: NavigationRouter;
}

/** The page's window, or `undefined` on the server — where there is nothing to navigate. */
const page = (): NavigationWindow | undefined =>
  (globalThis as { window?: NavigationWindow }).window;

/**
 * Go to `url` (resolved against the page) as a click on a link to it would: through the router on
 * this origin — its own rules and the server's gate decide swap, modal or full load — and as a
 * document load anywhere else, or when the page has no router. A fragment of the page on screen
 * (`#top`, same path and query) is the browser's: it scrolls, nothing is fetched or swapped.
 */
export function navigate(url: string, options: NavigateToOptions = {}): Promise<void> {
  const win = page();
  if (win === undefined) return Promise.resolve();
  const from = new URL(win.location.href);
  const to = new URL(url, from);
  const router = win.__xNavigation;
  // The link rule (`linkVerdict`'s `hashOnly`), asked here because the router's `navigate` is
  // reached past it: a fragment of the page on screen is the browser's scroll, and a fetch plus a
  // swap for it disposes every island on the page.
  const fragmentOnly =
    to.href.includes('#') && to.pathname === from.pathname && to.search === from.search;
  if (router === undefined || to.origin !== from.origin || fragmentOnly) {
    if (options.replace === true) win.location.replace(to.href);
    else win.location.assign(to.href);
    return Promise.resolve();
  }
  return router.navigate(to.href, options.replace === true ? { history: 'replace' } : {});
}

/**
 * The page on screen, rendered again by the server and swapped in where the visitor is scrolled —
 * after a write the page's own islands do not reflect. Without the router: a reload.
 */
export function refresh(): Promise<void> {
  const win = page();
  if (win === undefined) return Promise.resolve();
  if (win.__xNavigation === undefined) {
    win.location.reload();
    return Promise.resolve();
  }
  return win.__xNavigation.refresh().then(() => undefined);
}

/**
 * Open the `navigation: 'modal'` route at `path` over the page on screen (`#<path>`), pushed so
 * Back closes it. A path that is not a modal of this tab opens nothing, as a stale hash does.
 * Without the router: the modal route's own whole page. A path no hash can address (another
 * origin, `//host`, a relative one) is refused, `X_NAVIGATION_MODAL_PATH_INVALID`.
 */
export function openModal(path: string): Promise<void> {
  const win = page();
  const base = win?.location.href ?? 'http://localhost/';
  if (!path.startsWith('/') || modalAddress(`#${path}`, base) === null) {
    // Rejected, never thrown: one failure channel for an async call — `.catch` sees it.
    return Promise.reject(new NavigationModalPathInvalidError(path));
  }
  if (win === undefined) return Promise.resolve();
  if (win.__xNavigation === undefined) {
    win.location.assign(new URL(path, base).href);
    return Promise.resolve();
  }
  return win.__xNavigation.openModal(path);
}

/** Close the open modal as Escape does. Nothing is open without the router: nothing to do. */
export function closeModal(): void {
  page()?.__xNavigation?.closeModal();
}
