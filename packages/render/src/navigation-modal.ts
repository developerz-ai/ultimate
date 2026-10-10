/**
 * The route-presented modal: ONE native `<dialog>` over the page on screen, holding the `<main>` of
 * a page whose route declared `navigation: 'modal'`. The page beneath is never touched — its
 * islands, socket and state stay live, `showModal()` makes it inert — and the modal is addressed by
 * the URL's hash (`/runs#/runs/new`), so a reload, Back/Forward and a pasted link reopen it.
 * `navigation.ts` decides WHEN (`navigation-modal-rules.ts`); this file only shows and hides.
 */

import { disposeIslands } from './island-dispose';
import { metaOf } from './navigation-fetch';
import { entryOf, STATE_KEY, withoutFragment } from './navigation-history';
import {
  leaveModal,
  modalLocation,
  NAVIGATION_MODAL_ATTRIBUTE,
  NAVIGATION_PRESENTATION_META,
  type Presentation,
  type PresentationFacts,
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
  const heading = dialog.querySelector('h1, h2');
  if (heading === null) {
    dialog.setAttribute('aria-label', title);
    return;
  }
  if (heading.id === '') heading.id = 'x-modal-title';
  dialog.setAttribute('aria-labelledby', heading.id);
}

export function modalController(
  win: Window,
  rendered: () => string,
  ran: Set<string>,
  head: WeakSet<Element>,
): ModalController {
  const doc = win.document;
  let dialog: HTMLDialogElement | undefined;
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
    const open = dialog;
    if (open === undefined) return;
    dialog = undefined;
    openAt = undefined;
    leaving = false;
    disposeIslands(open);
    if (open.open) open.close();
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
    if (event.target === dialog && dialog !== undefined && !dialog.open) close();
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
    let open = dialog;
    if (open === undefined) {
      opener = doc.activeElement;
      title = doc.title;
      open = doc.createElement('dialog');
      open.setAttribute(NAVIGATION_MODAL_ATTRIBUTE, '');
      // Light dismiss: Escape AND a press outside close it, as every modal does (`Dialog` included).
      open.setAttribute('closedby', 'any');
      open.addEventListener('cancel', onCancel);
      open.addEventListener('close', onClose);
      open.addEventListener('pointerdown', onPointerDown);
      open.addEventListener('click', onClick);
      doc.body.append(open);
    } else {
      // One modal at a time: the next address replaces this one's content, in the same dialog.
      // Closed as `dismiss` closes it — no longer `dialog` — so its own `close` event, queued or
      // (in any engine that fires it at once) synchronous, is never read as the visitor closing.
      disposeIslands(open);
      dialog = undefined;
      if (open.open) open.close();
    }
    dialog = open;
    openAt = at;
    leaving = false;
    open.replaceChildren(...content);
    label(open, next.title);
    doc.title = next.title;
    open.showModal();
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
    close,
    clear() {
      clearEntry();
      dismiss();
    },
    dismiss,
  };
}
