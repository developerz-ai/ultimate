/**
 * `defineRoute({ navigation })` read back: the ONE spelling per meaning — `'prefetch'`,
 * `'document'`, `'modal'`, or `{ modal: true, prefetch: 'intent' }` for a modal that may also be
 * fetched on intent — and the two questions every reader asks of it (which mode, prefetched or
 * not), so no reader compares against a string the object form would slip past.
 */

/**
 * How the client router treats this page (`navigation: { client }` surfaces only). Absent: swapped
 * in on a click, never fetched before one. `'prefetch'`: may also be fetched on intent — only for a
 * page whose GET does nothing but render. `'document'`: always a real document load, the route run
 * once by the browser — for a GET that records something (an open, a download, a token consumed).
 * `'modal'`: presented OVER the page a visitor came from, addressed by the hash
 * (`/runs#/runs/new`) — a create form, a confirmation; a full load of its own URL is still the
 * whole page. Never fetched before a click: a modal is often a form, and its GET may prepare one.
 * The server enforces all three before `load` (`@ultimat3/http`'s navigation gate) and names a
 * modal in its document (`NAVIGATION_PRESENTATION_META`).
 */
export type RouteNavigationMode = 'prefetch' | 'document' | 'modal';

export const ROUTE_NAVIGATION_MODES: readonly RouteNavigationMode[] = [
  'prefetch',
  'document',
  'modal',
];

/**
 * A `'modal'` whose GET only reads (a peek, a detail view), so it may be fetched on hover, focus
 * or touchstart, as `'prefetch'` pages are — the click then fills the frame from the answer
 * already held. `'intent'` is the one value: the router's own hover/focus/touchstart prefetch.
 */
export interface RouteModalPrefetch {
  readonly modal: true;
  readonly prefetch: 'intent';
}

/** What `navigation:` takes. */
export type RouteNavigationDeclaration = RouteNavigationMode | RouteModalPrefetch;

const MODAL_PREFETCH_KEYS = ['modal', 'prefetch'] as const;

/** Exactly one of the four spellings — an object with anything more, or less, is not one. */
export function isRouteNavigation(value: unknown): value is RouteNavigationDeclaration {
  if (typeof value === 'string') return ROUTE_NAVIGATION_MODES.some((mode) => mode === value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const said = value as Record<string, unknown>;
  return (
    keys.length === MODAL_PREFETCH_KEYS.length &&
    MODAL_PREFETCH_KEYS.every((key) => keys.includes(key)) &&
    said['modal'] === true &&
    said['prefetch'] === 'intent'
  );
}

/** The mode a declaration says; the object form is a `'modal'`. */
export const navigationModeOf = (
  declared: RouteNavigationDeclaration | undefined,
): RouteNavigationMode | undefined =>
  declared === undefined || typeof declared === 'string' ? declared : 'modal';

/** Whether the server answers a prefetch of this page as a visit (`RouteNavigation.prefetch`). */
export const navigationPrefetches = (declared: RouteNavigationDeclaration | undefined): boolean =>
  declared === 'prefetch' || (typeof declared === 'object' && declared.prefetch === 'intent');
