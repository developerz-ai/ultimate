/**
 * Route-presented modals, as pure rules: the hash grammar (`/runs#/runs/new` — the PATH is the page
 * on screen, the HASH is the one modal over it), whether an answer is shown as a modal, as the page,
 * or dropped back to "just the page", and what leaving a modal does to history. The controller
 * (`navigation-modal.ts`) only gathers the facts; every rule is testable without a DOM.
 */

import type { ResponseVerdict } from './navigation-rules';

/**
 * `<meta name="ultimate-presentation" content="modal">` — on the document of a route that declared
 * `navigation: 'modal'`. The SERVER's word that this page is presented over another: the router
 * never decides it from a link, so a redirect target and a hand-typed hash are answered alike.
 */
export const NAVIGATION_PRESENTATION_META = 'ultimate-presentation';
/** On the `<dialog>` the router opens. `@ultimat3/ui`'s `global.scss` styles it, by this name. */
export const NAVIGATION_MODAL_ATTRIBUTE = 'data-x-modal';

/**
 * The modal a hash addresses — `#/runs/new?x=1` → `/runs/new?x=1` — or `null` for every other
 * fragment (`#below`, `#`, `#//host`, one that leaves the origin). NEVER throws: a stale or
 * hand-edited hash degrades to "just the page", it is never an error.
 */
export function modalAddress(hash: string, base: string): string | null {
  // `#//host` would resolve to another origin; a backslash is a slash to the URL parser.
  if (!hash.startsWith('#/') || hash.startsWith('#//') || hash.includes('\\')) return null;
  const said = hash.slice(1);
  if (!URL.canParse(base) || !URL.canParse(said, base)) return null;
  const url = new URL(said, base);
  if (url.origin !== new URL(base).origin) return null;
  return `${url.pathname}${url.search}`;
}

/** The URL the address bar shows for `address` over the page `page`: `/runs#/runs/new`. */
export const modalLocation = (page: string, address: string): string =>
  `${page.split('#')[0] ?? page}#${address}`;

/** `/runs/new?x=1` of an absolute URL — the hash a modal at that URL is addressed by. */
export const addressOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/**
 * - `modal`: shown in the dialog over the page on screen.
 * - `page`: the router's ordinary handling (a swap, a follow, a load…).
 * - `degrade`: the hash named something that is not a modal for this tab — the hash is dropped in
 *   place and the page stays, with nothing loaded, followed or shown as an error.
 */
export type Presentation = 'modal' | 'page' | 'degrade';

/** What decides a presentation, read off the answer, the tab and how the request came about. */
export interface PresentationFacts {
  /** The address came from the URL's hash (a load, Back/Forward, a typed hash), not a click. */
  readonly fromHash: boolean;
  readonly method: 'GET' | 'POST';
  readonly verdict: ResponseVerdict['kind'];
  readonly status: number;
  /** The answer carries `NAVIGATION_PRESENTATION_META` = `modal`. */
  readonly modalPage: boolean;
  /** A modal is open now. */
  readonly modalOpen: boolean;
  /** The answered URL, and the page on screen — both without a fragment. */
  readonly landed: string;
  readonly rendered: string;
  /** The answer belongs to another principal or build (`answerMovesTab`). */
  readonly movesTab: boolean;
}

export function presentation(facts: PresentationFacts): Presentation {
  const modal = facts.verdict === 'swap' && facts.modalPage && !facts.movesTab;
  // From the hash, only a 2xx modal of this tab opens; anything else (a 404, a redirect, a page that
  // is not a modal, another principal) is a stale address — never followed, never loaded.
  if (facts.fromHash) {
    return modal && facts.status >= 200 && facts.status < 300 ? 'modal' : 'degrade';
  }
  if (!modal) return 'page';
  // A POST re-renders a modal only from inside one: the full page's own form stays a page.
  if (facts.method === 'POST') return facts.modalOpen ? 'modal' : 'page';
  // A link to the page on screen is that page, whatever it declared.
  return facts.landed === facts.rendered ? 'page' : 'modal';
}

/**
 * The history move for a modal shown: a POST answered in place re-renders it where it is (the
 * entry is the modal's already); Back/Forward and a hash move nothing; a click pushes, so Back
 * steps out of it (nesting deeper is a deeper path in the same dialog, with its own Back stop).
 */
export function modalHistory(
  method: 'GET' | 'POST',
  history: 'push' | 'replace' | 'none' | undefined,
): 'push' | 'replace' | 'none' {
  if (history === 'none') return 'none';
  return method === 'POST' ? 'replace' : (history ?? 'push');
}

/**
 * Leaving an open modal for a PAGE: the modal's entry is never left behind to reopen a spent form
 * on Back. Onto the page beneath, through an entry this router pushed: Back to it (two entries for
 * one URL read as a Back that did nothing). Anywhere else: the modal's entry is replaced.
 */
export function leaveModal(facts: {
  readonly history: 'push' | 'replace' | 'none' | undefined;
  readonly landed: string;
  readonly rendered: string;
  readonly owned: boolean;
}): 'back' | 'replace' | 'none' {
  if (facts.history === 'none') return 'none';
  return facts.landed === facts.rendered && facts.owned ? 'back' : 'replace';
}
