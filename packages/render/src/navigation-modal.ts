/**
 * The route-presented modal: ONE native `<dialog>` over the page on screen, holding the `<main>` of
 * a page whose route declared `navigation: 'modal'`. The page beneath is never touched — its
 * islands, socket and state stay live, out of reach behind the top layer — and the modal is
 * addressed by the URL's hash (`/runs#/runs/new`), so a reload, Back/Forward and a pasted link
 * reopen it. A route the document names a modal (`NAVIGATION_MODALS_META`) opens on the click, as a
 * busy frame the answer fills. `navigation.ts` decides WHEN (`navigation-modal-rules.ts`); this
 * file only shows and hides, and `navigation-modal-frame.ts` is the dialog's DOM.
 */

import { disposeIslands } from './island-dispose';
import { metaOf } from './navigation-fetch';
import { entryOf, STATE_KEY, withoutFragment } from './navigation-history';
import {
  bodyOf,
  createModal,
  focusInto,
  keepModal,
  lowerModal,
  type ModalLabels,
  markBusy,
  markIdle,
  raiseModal,
} from './navigation-modal-frame';
import {
  declaresModal,
  leaveModal,
  modalLocation,
  NAVIGATION_MODALS_META,
  NAVIGATION_PRESENTATION_META,
  type Presentation,
  type PresentationFacts,
  parseModalRoutes,
  presentation,
} from './navigation-modal-rules';
import { runScripts } from './navigation-swap';

export interface ModalController {
  /** The open modal's address (`/runs/new`), or `undefined`. */
  readonly address: string | undefined;
  /** The entry on screen is the one this router pushed for the open modal. */
  owned(): boolean;
  /** `presentation`, with what this tab knows filled in: the answer's meta, the open modal. */
  presentationOf(
    next: Document | null,
    landed: string,
    facts: Omit<PresentationFacts, 'modalPage' | 'modalOpen' | 'landed' | 'rendered'>,
  ): Presentation;
  /** `leaveModal` for a page answered over the open modal; `undefined` with none open. */
  leaveFor(
    history: 'push' | 'replace' | 'none' | undefined,
    landed: string,
  ): 'back' | 'replace' | 'none' | undefined;
  /** Shows `next`'s `<main>` as the modal at `address`; its stylesheets are already loaded. */
  present(
    next: Document,
    address: string,
    landed: string,
    history: 'push' | 'replace' | 'none',
  ): Promise<void>;
  /**
   * A GET of `url` is starting: when the document names it a modal, the dialog opens NOW — a busy
   * frame, or the open modal marked busy — and `true` is answered. Nothing is pushed until
   * `present`; closing it before then aborts the request (the controller's `abandon`).
   */
  loading(url: string): boolean;
  /** A newer navigation took over: the frame is no longer this request's to abort. */
  release(): void;
  /** The request ended without `present`: a frame with no content goes, an open modal is idle. */
  settle(): void;
  /** Escape, a native close, a link to the page beneath: Back when this router pushed the entry. */
  close(): void;
  /** The hash names no modal for this tab: dropped in place, the page stays. */
  clear(): void;
  /** The DOM half only, once history already says closed. */
  dismiss(): void;
}

/**
 * Hrefs and actions as written resolve against the MODAL's URL, as on its own page: moved over
 * another page, `href="edit"` and a form with no `action` would point at the page beneath.
 */
function rebase(root: Element, landed: string): void {
  const resolve = (el: Element, name: string): void => {
    const raw = el.getAttribute(name) ?? '';
    if (raw.startsWith('#') || !URL.canParse(raw, landed)) return;
    el.setAttribute(name, new URL(raw, landed).href);
  };
  for (const el of root.querySelectorAll('a[href], area[href]')) resolve(el, 'href');
  for (const el of root.querySelectorAll('[formaction]')) resolve(el, 'formaction');
  for (const form of root.querySelectorAll('form')) {
    if ((form.getAttribute('action') ?? '') === '') form.setAttribute('action', landed);
    else resolve(form, 'action');
  }
}

/** Named by its first heading, as `@ultimat3/ui`'s `Dialog` is by its title. */
function label(dialog: HTMLDialogElement, title: string): void {
  const heading = bodyOf(dialog).querySelector('h1, h2');
  if (heading === null) {
    dialog.removeAttribute('aria-labelledby');
    dialog.setAttribute('aria-label', title);
    return;
  }
  if (heading.id === '') heading.id = 'x-modal-title';
  dialog.removeAttribute('aria-label');
  dialog.setAttribute('aria-labelledby', heading.id);
}

/**
 * `abandon` aborts the request a frame is waiting on — called when the visitor closes it (Escape,
 * the close button, Back) before its answer arrived, never when the router itself moves on.
 */
export function modalController(
  win: Window,
  rendered: () => string,
  ran: Set<string>,
  head: WeakSet<Element>,
  abandon: () => void = () => undefined,
): ModalController {
  const doc = win.document;
  let dialog: HTMLDialogElement | undefined;
  /** A request is on its way to fill the dialog: closing it now aborts that request. */
  let pending = false;
  let unkeep: () => void = () => undefined;
  /** The open modal's path (`/runs/new`), as the URL bar shows it. */
  let openAt: string | undefined;
  let opener: Element | null = null;
  let title = '';
  /** A close is under way (a Back in flight): a second Escape must not go Back twice. */
  let leaving = false;

  const owned = (): boolean => {
    // The modal the entry on screen was pushed for — a path, compared with the one open.
    const pushedFor = entryOf(win.history.state)?.modal;
    return openAt !== undefined && pushedFor === openAt;
  };

  const dismiss = (): void => {
    if (pending) {
      pending = false;
      abandon();
    }
    const open = dialog;
    if (open === undefined) return;
    dialog = undefined;
    openAt = undefined;
    leaving = false;
    unkeep();
    disposeIslands(open);
    lowerModal(open);
    open.remove();
    doc.title = title;
    // Back where the visitor was: the link or button that opened it, when it is still there.
    if (opener?.isConnected === true) (opener as HTMLElement).focus?.({ preventScroll: true });
    opener = null;
  };

  /** The modal's mark off the entry, the hash off the URL — Back would leave the app. */
  const clearEntry = (): void => {
    const state = (win.history.state ?? {}) as Record<string, unknown>;
    const { modal: _modal, ...entry } = entryOf(state) ?? {
      scroll: [win.scrollX, win.scrollY] as const,
      doc: rendered(),
    };
    win.history.replaceState({ ...state, [STATE_KEY]: entry }, '', rendered());
  };

  const close = (): void => {
    // A frame with no content yet: nothing was pushed, so closing is the request abandoned.
    if (openAt === undefined && pending) {
      dismiss();
      return;
    }
    if (pending) {
      pending = false;
      abandon();
    }
    if (openAt === undefined || leaving) return;
    if (owned()) {
      leaving = true;
      // `popstate` reconciles: the entry beneath has no modal, so `dismiss` runs there.
      win.history.back();
      return;
    }
    clearEntry();
    dismiss();
  };

  const onCancel = (event: Event): void => {
    event.preventDefault();
    close();
  };
  // A `<form method="dialog">`, or an Escape the browser would not let be cancelled: the dialog
  // closed itself, and the URL must follow. One it closed for `dismiss` is no longer `dialog`.
  const onClose = (event: Event): void => {
    if (event.target !== dialog || dialog === undefined || dialog.open) return;
    // Closed by the browser, still a popover: out of the top layer now, not when history settles.
    lowerModal(dialog);
    close();
  };
  // A press on the backdrop. `closedby="any"` has the browser close the dialog itself (and fire
  // `close`, read above); a browser without it reports the press as a click whose target is the
  // dialog and whose point is outside its box — a click on the dialog's own padding is inside it
  // and closes nothing, and so does one a keyboard made, which lands on a control. The press must
  // START outside too: one that began inside (selecting text, dragging out of a field) and was
  // released on the backdrop also clicks the dialog, and must not throw the visitor's work away.
  // Idempotent with the browser's own: a close already under way is not started twice.
  const outside = (event: Event): boolean => {
    const open = dialog;
    if (open === undefined || event.target !== open) return false;
    const { clientX: x, clientY: y } = event as MouseEvent;
    const box = open.getBoundingClientRect();
    return x < box.left || x > box.right || y < box.top || y > box.bottom;
  };
  let pressedOutside = false;
  const onPointerDown = (event: Event): void => {
    pressedOutside = outside(event);
  };
  const onClick = (event: Event): void => {
    const began = pressedOutside;
    pressedOutside = false;
    if (began && outside(event)) close();
  };

  /** A new dialog, its listeners, opened into the top layer: the page's title and focus kept. */
  const raise = (labels: ModalLabels | undefined): HTMLDialogElement => {
    opener = doc.activeElement;
    title = doc.title;
    const open = createModal(doc, labels, () => close());
    open.addEventListener('cancel', onCancel);
    open.addEventListener('close', onClose);
    open.addEventListener('pointerdown', onPointerDown);
    open.addEventListener('click', onClick);
    doc.body.append(open);
    raiseModal(open);
    unkeep = keepModal(doc, open, close);
    return open;
  };

  const loading = (url: string): boolean => {
    const named = parseModalRoutes(metaOf(doc, NAVIGATION_MODALS_META));
    if (named === undefined || !declaresModal(url, named.routes)) return false;
    pending = true;
    if (dialog !== undefined) {
      // One modal at a time: the open one stays on screen, busy, until the next one replaces it.
      markBusy(dialog, false);
      return true;
    }
    dialog = raise(named);
    markBusy(dialog, true);
    dialog.setAttribute('aria-label', named.loading);
    // Inside from the first frame: Escape, Tab and a screen reader are already the dialog's.
    dialog.focus({ preventScroll: true });
    return true;
  };

  const settle = (): void => {
    pending = false;
    if (dialog === undefined) return;
    if (openAt === undefined) dismiss();
    else markIdle(dialog);
  };

  const present = async (
    next: Document,
    at: string,
    landed: string,
    history: 'push' | 'replace' | 'none',
  ): Promise<void> => {
    const source = next.querySelector('main') ?? next.body;
    // Scripts outside `<main>` (the hydration runtime, island modules) boot what is inside it.
    const outside = [...next.body.querySelectorAll('script')].filter((s) => !source.contains(s));
    rebase(source, landed);
    const content = [...source.childNodes, ...outside].map((node) => doc.adoptNode(node));
    const headScripts = [...next.head.querySelectorAll('script[src]')] as HTMLScriptElement[];
    // The frame the click opened, the modal already open, or — for a document that names no
    // modal routes — a dialog opened now. Never closed and reopened: its `close` event would read
    // as the visitor closing, and reopening is the work this frame exists to do once.
    const fresh = dialog === undefined;
    const open = dialog ?? raise(parseModalRoutes(metaOf(doc, NAVIGATION_MODALS_META)));
    disposeIslands(open);
    dialog = open;
    openAt = at;
    leaving = false;
    pending = false;
    const body = bodyOf(open);
    // Focus moves in as `showModal()` moved it — unless the visitor already moved it to the close
    // button while the frame waited.
    const active = doc.activeElement;
    const moveFocus = fresh || active === null || active === open || body.contains(active);
    body.replaceChildren(...content);
    markIdle(open);
    label(open, next.title);
    doc.title = next.title;
    if (moveFocus || doc.activeElement?.isConnected !== true) focusInto(open);
    if (history !== 'none') {
      const state = {
        [STATE_KEY]: { scroll: [win.scrollX, win.scrollY], doc: rendered(), modal: at },
      };
      const url = modalLocation(rendered(), at);
      if (history === 'push') win.history.pushState(state, '', url);
      else win.history.replaceState(state, '', url);
    }
    await runScripts(headScripts, ran, (fresh) => {
      doc.head.append(fresh);
      head.add(fresh);
    });
    await runScripts([...open.querySelectorAll('script')], ran, (fresh, inert) =>
      inert.replaceWith(fresh),
    );
  };

  return {
    get address() {
      return openAt;
    },
    owned,
    presentationOf: (next, landed, facts) =>
      presentation({
        ...facts,
        modalPage: next !== null && metaOf(next, NAVIGATION_PRESENTATION_META) === 'modal',
        modalOpen: openAt !== undefined,
        landed: withoutFragment(landed),
        rendered: rendered(),
      }),
    leaveFor: (history, landed) =>
      openAt === undefined
        ? undefined
        : leaveModal({
            history,
            landed: withoutFragment(landed),
            rendered: rendered(),
            owned: owned(),
          }),
    present,
    loading,
    release() {
      pending = false;
    },
    settle,
    close,
    clear() {
      clearEntry();
      dismiss();
    },
    dismiss,
  };
}
