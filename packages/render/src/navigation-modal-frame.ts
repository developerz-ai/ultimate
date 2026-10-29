/**
 * The route-presented modal's `<dialog>` as DOM: its frame (a body region, a close button), how it
 * is opened into the top layer and kept modal, and where focus goes. `navigation-modal.ts` decides
 * when; this file only builds, opens, fills and hides.
 *
 * Opened with `show()` + `showPopover()`, NOT `showModal()`: a modal dialog makes the rest of the
 * document inert, and Chrome computes inertness in style — every element of the page beneath has
 * its style recalculated (7,011 elements, 4x CPU: 124 ms of RecalcStyle for `showModal()`, 2.6 ms
 * this way; `inert` on one wrapper costs the same 111 ms). The popover is the top layer and the
 * `::backdrop`; `aria-modal` tells assistive technology the page beneath is out of reach; the
 * backdrop takes every press, and Tab wraps inside. A browser without popovers gets `showModal()`.
 */

import {
  type ModalRoutes,
  NAVIGATION_MODAL_ATTRIBUTE,
  NAVIGATION_MODAL_BODY_ATTRIBUTE,
  NAVIGATION_MODAL_CLOSE_ATTRIBUTE,
  NAVIGATION_MODAL_SKELETON_ATTRIBUTE,
} from './navigation-modal-rules';

export type ModalLabels = Pick<ModalRoutes, 'close' | 'loading'>;

/** What may take focus inside the dialog — filtered for `disabled` and `tabindex="-1"` below. */
const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, [tabindex], [contenteditable]';

const supportsPopover = (el: HTMLElement): boolean =>
  typeof (el as { showPopover?: unknown }).showPopover === 'function';

/** The region the modal page's `<main>` goes in. */
export const bodyOf = (dialog: HTMLDialogElement): Element =>
  dialog.querySelector(`[${NAVIGATION_MODAL_BODY_ATTRIBUTE}]`) ?? dialog;

/**
 * A dialog with its body region and, when the document named the words for it, its close button:
 * a plain `type="button"` that closes as Escape does (`onClose`) — never a `<form>`, which a page's
 * own `dialog form` would find first. AFTER the body, so the first focusable thing is the page's.
 */
export function createModal(
  doc: Document,
  labels: ModalLabels | undefined,
  onClose: () => void,
): HTMLDialogElement {
  const dialog = doc.createElement('dialog');
  dialog.setAttribute(NAVIGATION_MODAL_ATTRIBUTE, '');
  // Light dismiss: Escape AND a press outside close it, as every modal does (`Dialog` included).
  dialog.setAttribute('closedby', 'any');
  dialog.setAttribute('aria-modal', 'true');
  // Focusable itself, so focus is inside from the first frame — before there is content to take it.
  dialog.setAttribute('tabindex', '-1');
  const body = doc.createElement('div');
  body.setAttribute(NAVIGATION_MODAL_BODY_ATTRIBUTE, '');
  dialog.append(body);
  if (labels !== undefined) {
    const close = doc.createElement('button');
    close.setAttribute('type', 'button');
    close.setAttribute(NAVIGATION_MODAL_CLOSE_ATTRIBUTE, '');
    close.setAttribute('aria-label', labels.close);
    close.addEventListener('click', onClose);
    dialog.append(close);
  }
  return dialog;
}

/** The body as "on its way": busy, a skeleton in place of content that is not there yet. */
export function markBusy(dialog: HTMLDialogElement, empty: boolean): void {
  const body = bodyOf(dialog);
  body.setAttribute('aria-busy', 'true');
  if (!empty) return;
  const skeleton = dialog.ownerDocument.createElement('div');
  skeleton.setAttribute(NAVIGATION_MODAL_SKELETON_ATTRIBUTE, '');
  skeleton.setAttribute('aria-hidden', 'true');
  body.replaceChildren(skeleton);
}

export const markIdle = (dialog: HTMLDialogElement): void =>
  bodyOf(dialog).removeAttribute('aria-busy');

/** Into the top layer, without the inert document (see the header); `showModal()` without popovers. */
export function raiseModal(dialog: HTMLDialogElement): void {
  if (!supportsPopover(dialog)) {
    dialog.showModal();
    return;
  }
  dialog.setAttribute('popover', 'manual');
  dialog.show();
  dialog.showPopover();
}

/** Out of the top layer: the popover first, so no frame shows a backdrop over nothing. */
export function lowerModal(dialog: HTMLDialogElement): void {
  if (dialog.hasAttribute('popover') && supportsPopover(dialog)) {
    try {
      dialog.hidePopover();
    } catch {
      // Already hidden (removed, or hidden by the browser): nothing is showing.
    }
  }
  if (dialog.open) dialog.close();
}

const focusable = (dialog: HTMLDialogElement): HTMLElement[] =>
  [...dialog.querySelectorAll(FOCUSABLE)].filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('tabindex') !== '-1' &&
      el.getAttribute('type') !== 'hidden',
  ) as HTMLElement[];

/** As `showModal()` focuses: `[autofocus]`, else the first focusable thing, else the dialog. */
export function focusInto(dialog: HTMLDialogElement): void {
  const target =
    (dialog.querySelector('[autofocus]') as HTMLElement | null) ?? focusable(dialog)[0] ?? dialog;
  target.focus?.({ preventScroll: true });
}

/**
 * What `showModal()` gave for free and a popover does not: Tab stays inside, and — where the
 * browser has no `closedby` — Escape closes. Returns the remover. Escape on something that is
 * itself a dialog or popover inside (a `Dialog`, a menu) is that one's.
 */
export function keepModal(
  doc: Document,
  dialog: HTMLDialogElement,
  onEscape: () => void,
): () => void {
  if (!dialog.hasAttribute('popover')) return () => undefined;
  const escapes = !('closedBy' in dialog);
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const at = event.target as Element | null;
    const inner = at?.closest?.('dialog[open], [popover]') ?? null;
    if (event.key === 'Escape' && escapes && (inner === null || inner === dialog)) {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab' || (inner !== null && inner !== dialog)) return;
    const all = focusable(dialog);
    const first = all[0];
    const last = all[all.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = doc.activeElement;
    const inside = active !== null && dialog.contains(active);
    if (
      event.shiftKey ? !inside || active === first || active === dialog : !inside || active === last
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  doc.addEventListener('keydown', onKey as EventListener);
  return () => doc.removeEventListener('keydown', onKey as EventListener);
}
