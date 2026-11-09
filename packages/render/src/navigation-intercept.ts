/**
 * The client router's interception: which DOM events it listens to, what each one turns into (a
 * soft navigation, a prefetch, a Back that moves only the scroll), and the hover timer behind a
 * prefetch. Split from `navigation.ts` (plan 101 slice 14 P5) so that file is the controller.
 */

import { anchorOf, intentUrl, linkFacts, submitFacts } from './navigation-dom';
import { entryOf, withoutFragment } from './navigation-history';
import type { ModalController } from './navigation-modal';
import { modalAddress } from './navigation-modal-rules';
import type { PressTracker } from './navigation-press';
import { formVerdict, linkVerdict, NAVIGATION_PREFETCH_DELAY_MS } from './navigation-rules';
import type { ScrollKeeper } from './navigation-scroll';

/** What a listener may start: a soft visit, a POST, or a Back that the page on screen answers. */
type Navigate = (
  url: string,
  options?: { method?: 'POST'; body?: BodyInit; history?: 'none' },
) => Promise<void>;

/**
 * `[cancelIntent, stop]`: a tuple and positional parameters rather than a host object, because
 * this script ships to every opted-in page and a property name survives minification — the
 * object form cost the router 219 B for nothing it did (axiom 9).
 */
export type Interception = readonly [cancelIntent: () => void, stop: () => void];

export function interceptNavigation(
  win: Window,
  press: PressTracker,
  modal: Pick<ModalController, 'address' | 'close'>,
  scroll: Pick<ScrollKeeper, 'cancel'>,
  /** The document on screen, without its fragment. */
  rendered: () => string,
  /** After an answer for another principal or build was shown in place (`answerMovesTab`). */
  untrusted: () => boolean,
  navigate: Navigate,
  prefetch: (url: string) => void,
  /** A Back/Forward landed: the router's own Back is no longer traversing. */
  popped: () => void,
  reconcile: () => void,
): Interception {
  const doc = win.document;
  /** The pending prefetch of a hover, cancelled by anything that navigates. */
  let intent: number | undefined;
  const cancelIntent = (): void => win.clearTimeout(intent);

  const onPress = (): void => {
    press.onPress();
    // A press is not a hover: the click it becomes navigates, and a guess on its heels is a
    // second request for the same page.
    cancelIntent();
  };

  const onClick = (event: MouseEvent): void => {
    cancelIntent();
    if (press.overlayClick(event)) return;
    const anchor = anchorOf(event.target);
    if (anchor === null) return;
    const verdict = linkVerdict(linkFacts(win, anchor, event));
    if (verdict.kind !== 'soft') return;
    event.preventDefault();
    // A link to the page beneath an open modal (its Cancel) closes the modal: nothing is fetched.
    if (modal.address !== undefined && withoutFragment(verdict.url) === rendered()) modal.close();
    else void navigate(verdict.url);
  };

  const onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    // An untrusted tab (`answerMovesTab`) leaves every form to the browser.
    if (!(form instanceof HTMLFormElement) || untrusted()) return;
    const { facts, fields } = submitFacts(win, form, event.submitter, event.defaultPrevented);
    const verdict = formVerdict(facts);
    if (verdict.kind === 'native') return;
    event.preventDefault();
    if (verdict.kind === 'get') {
      void navigate(verdict.url);
      return;
    }
    const body =
      verdict.encoding === 'multipart'
        ? fields
        : new URLSearchParams(facts.fields.map(([name, value]) => [name, value]));
    void navigate(verdict.url, { method: 'POST', body });
  };

  const onIntent = (event: Event): void => {
    // The focus a press gives a link: its click is a moment away, and it navigates.
    if (event.type === 'focusin' && press.pressed()) return;
    const url = intentUrl(win, event.target);
    if (url === undefined) return;
    cancelIntent();
    const delay = event.type === 'pointerover' ? NAVIGATION_PREFETCH_DELAY_MS : 0;
    intent = win.setTimeout(() => prefetch(url), delay);
  };

  /**
   * Back/forward. The router's own entries name the document they show; any other entry (an app's
   * own `pushState`) shows the document of its PATH. Either way, when that is not the document on
   * screen it is fetched; when it is, only the scroll moves — the app keeps its own history.
   */
  const onPop = (event: PopStateEvent): void => {
    scroll.cancel();
    popped();
    // The page is the PATH: a modal's hash is the modal's (`reconcile`), never the page's fragment.
    const at = win.location.href;
    const url = modalAddress(new URL(at).hash, at) === null ? at : withoutFragment(at);
    const entry = entryOf(event.state);
    const wanted = entry?.doc ?? withoutFragment(url);
    const same =
      entry !== undefined
        ? wanted === rendered()
        : new URL(url).pathname === new URL(rendered()).pathname;
    if (!same) {
      void navigate(url, { history: 'none' });
      return;
    }
    if (entry !== undefined) {
      win.scrollTo({
        left: entry.scroll[0],
        top: entry.scroll[1],
        behavior: 'instant' as ScrollBehavior,
      });
    }
    reconcile();
  };

  // `window`, bubble phase: after every handler on the page — Solid delegates to `document` — has
  // had its chance to `preventDefault`, which the rules then honour.
  const passive = { passive: true };
  const pressing = { capture: true, passive: true };
  const listeners: readonly (readonly [EventTarget, string, EventListener, object?])[] = [
    [win, 'click', onClick as EventListener],
    [win, 'submit', onSubmit as EventListener],
    [doc, 'pointerover', onIntent, passive],
    [doc, 'pointerout', cancelIntent, passive],
    [doc, 'focusin', onIntent],
    [doc, 'touchstart', onIntent, passive],
    [win, 'popstate', onPop as EventListener],
    [win, 'hashchange', reconcile],
    [doc, 'pointerdown', onPress, pressing],
    [doc, 'pointerup', press.onRelease, pressing],
    [doc, 'pointercancel', press.onRelease, pressing],
  ];
  for (const [target, type, listener, options] of listeners) {
    target.addEventListener(type, listener, options);
  }

  return [
    cancelIntent,
    () => {
      for (const [target, type, listener, options] of listeners) {
        target.removeEventListener(type, listener, options);
      }
    },
  ];
}
