/**
 * The client router: soft navigation over server-rendered documents. A same-surface link or form
 * fetches the next document the server renders anyway (its own mode, its own policy, its own cache
 * headers) and swaps it in, so the tab keeps its islands, its socket and its state between pages.
 * NOT a render mode — every page is still rendered by its route; without this script, or with
 * `data-x-reload`, the same markup is an ordinary full-page web app.
 *
 * One rule over every branch: NOTHING THE ROUTER SENT IS SENT AGAIN. The server answers a request
 * a route may not take before running it (`@ultimat3/http`'s navigation gate), hands a redirect
 * over instead of letting `fetch` follow it, and a POST is never re-submitted — after a failed
 * one, only the server knows what landed.
 *
 * Loaded as one deferred classic script (`@ultimat3/cli` builds it to
 * `/_x/assets/navigation/<hash>.js`) on documents whose surface opted in (`navigation: { client:
 * [...] }` in `app.config.ts`).
 */

import { navigationCache } from './navigation-cache';
import {
  anchorOf,
  announcer,
  focusMain,
  handOver,
  intentUrl,
  linkFacts,
  submitFacts,
  transition,
} from './navigation-dom';
import {
  type Answer,
  fetchDocument,
  heldOrFetched,
  metaOf,
  responseFactsOf,
} from './navigation-fetch';
import {
  type EntryState,
  entryOf,
  STATE_KEY,
  scrollAfter,
  withoutFragment,
} from './navigation-history';
import { modalController } from './navigation-modal';
import { addressOf, modalAddress, modalHistory } from './navigation-modal-rules';
import { pressTracker } from './navigation-press';
import {
  answerMovesTab,
  formVerdict,
  linkVerdict,
  NAVIGATE_EVENT,
  NAVIGATED_EVENT,
  NAVIGATING_ATTRIBUTE,
  NAVIGATION_ERROR_EVENT,
  NAVIGATION_MAX_HOPS,
  NAVIGATION_META,
  NAVIGATION_PREFETCH_DELAY_MS,
  NAVIGATION_PROGRESS_DELAY_MS,
  responseVerdict,
} from './navigation-rules';
import { scrollKeeper } from './navigation-scroll';
import {
  documentHead,
  loadStylesheets,
  missingStylesheets,
  notePersisted,
  runScripts,
  swapDocument,
} from './navigation-swap';
import { tabSync } from './navigation-tabs';

export interface NavigateOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: BodyInit;
  /** `push` for a new visit, `replace` for the same URL, `none` for a back/forward. */
  readonly history?: 'push' | 'replace' | 'none';
  /** Redirects already followed for this navigation. */
  readonly hops?: number;
  /** The URL's hash addressed it: a modal, or nothing — never a page (`presentation`). */
  readonly fromHash?: boolean;
}

export interface NavigationRouter {
  navigate(url: string, options?: NavigateOptions): Promise<void>;
  prefetch(url: string): void;
  /** The page on screen, fetched again and swapped in where it is scrolled. */
  refresh(): Promise<void>;
  /** `path` as the modal over this page (`#<path>`); anything but a modal of this tab: nothing. */
  openModal(path: string): Promise<void>;
  /** As Escape: Back through the router's own entry, else the hash dropped in place. */
  closeModal(): void;
  stop(): void;
}

interface RouterWindow extends Window {
  __xNavigation?: NavigationRouter;
}

/**
 * Starts the router on a document that opted in, once per tab; `undefined` on one that did not —
 * a page without `ultimate-navigation` is never intercepted, whatever script it loaded.
 */
export function startNavigation(win: RouterWindow = window): NavigationRouter | undefined {
  const doc = win.document;
  if (win.__xNavigation !== undefined) return win.__xNavigation;
  if (metaOf(doc, NAVIGATION_META) === null || !('DOMParser' in win)) return undefined;

  const cache = navigationCache<Answer>();
  const ran = new Set(
    [...doc.querySelectorAll('script[src]')].map(
      (s) => new URL(s.getAttribute('src') ?? '', doc.baseURI).href,
    ),
  );
  let rendered = withoutFragment(win.location.href);
  /** The URL a navigation in flight is fetching: a prefetch never asks for it a second time. */
  let navigatingTo: string | undefined;
  const press = pressTracker(doc);
  /** The pending prefetch of a hover, cancelled by anything that navigates. */
  let intent: number | undefined;
  let untrusted = false;
  let backing = false; // a Back this router started is traversing: the URL is still the one left
  let inflight: AbortController | undefined;
  const live = announcer(doc);
  const owned = documentHead(doc);
  notePersisted(doc);
  const tabs = tabSync(win, () => cache.clear());
  const forget = tabs.forget;
  const scroll = scrollKeeper(win, () => rendered);
  const modal = modalController(win, () => rendered, ran, owned);

  const request = (url: string, purpose: 'soft' | 'prefetch', init?: RequestInit) =>
    fetchDocument(win, doc, url, purpose, init);

  const prefetch = (url: string): void => {
    const key = withoutFragment(url);
    if (untrusted || key === rendered || key === navigatingTo || cache.get(url) !== undefined) {
      return;
    }
    // Cached whatever it answers: an empty `204` (the route did not opt in) is remembered too, so
    // a second hover does not ask again. Only a reusable page ever answers a click (`reusable`).
    cache.set(url, request(url, 'prefetch'));
  };

  /** Cancelable; its default is a GET of the page the visitor is on. Nothing is re-sent. */
  const failed = (url: string, method: string, reason: string): void => {
    const detail = { url, method, reason };
    const event = new CustomEvent(NAVIGATION_ERROR_EVENT, { detail, cancelable: true });
    if (!doc.dispatchEvent(event)) return;
    // Under a modal the URL differs only by its hash, which `assign` merely scrolls to: reloaded,
    // the page and its modal are both asked for again (the entry is the router's own GET).
    if (modal.address === undefined) win.location.assign(win.location.href);
    else win.location.reload();
  };

  const answerFor = (
    url: string,
    method: 'GET' | 'POST',
    options: NavigateOptions,
    signal: AbortSignal,
  ) => {
    if (method === 'POST') {
      // Before AND once it settles, landed or not: a guess sent while the write was in flight
      // may have rendered the old state, and a write that failed here may still have committed.
      forget();
      const body = options.body === undefined ? {} : { body: options.body };
      return request(url, 'soft', { method, ...body, signal }).finally(forget);
    }
    return heldOrFetched(cache, url, () => request(url, 'soft', { signal }));
  };

  const navigate = async (url: string, options: NavigateOptions = {}): Promise<void> => {
    // The redirect chain's only exit is `hops >= NAVIGATION_MAX_HOPS`, which `NaN` never meets.
    // `hops` is this router's own recursion counter (nothing outside it can reach `navigate`), so a
    // non-count is a broken caller, not input: it fails CLOSED as an exhausted chain — one request,
    // then the browser loads the page — instead of shipping the error renderer (~2 KB) to every page.
    const asked = options.hops ?? 0;
    const hops = Number.isSafeInteger(asked) && asked >= 0 ? asked : NAVIGATION_MAX_HOPS;
    const method = options.method ?? 'GET';
    // After an answer for another principal or build was shown in place, this tab is no longer
    // trusted to swap: every navigation is a real load (`answerMovesTab`).
    if (untrusted && method === 'GET') {
      if (options.fromHash === true) modal.clear();
      else win.location.assign(url);
      return;
    }
    const detail = { url, method };
    if (!doc.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail, cancelable: true }))) return;
    inflight?.abort();
    const mine = new AbortController();
    inflight = mine;
    win.clearTimeout(intent);
    navigatingTo = withoutFragment(url);
    if (options.history !== 'none') scroll.save();
    const progress = win.setTimeout(
      () => doc.documentElement.setAttribute(NAVIGATING_ATTRIBUTE, ''),
      NAVIGATION_PROGRESS_DELAY_MS,
    );
    try {
      let answer: Answer;
      try {
        answer = await answerFor(url, method, options, mine.signal);
      } catch {
        if (mine.signal.aborted) return;
        // A GET that never arrived is the browser's to try; a POST that failed is never re-sent.
        if (method === 'GET') win.location.assign(url);
        else failed(url, method, 'the request failed on the network');
        return;
      }
      if (mine.signal.aborted) return;
      const next =
        answer.html === null ? null : new DOMParser().parseFromString(answer.html, 'text/html');
      const facts = responseFactsOf(doc, next, answer, { method, requested: url, hops });
      const verdict = responseVerdict(facts);
      const landed = `${withoutFragment(url)}${new URL(url).hash}`;
      const shown = modal.presentationOf(next, landed, {
        fromHash: options.fromHash === true,
        method,
        verdict: verdict.kind,
        status: answer.status,
        movesTab: answerMovesTab(facts),
      });
      if (shown === 'degrade') {
        modal.clear();
        return;
      }
      switch (verdict.kind) {
        case 'stay':
          return;
        case 'failed':
          failed(url, method, verdict.reason);
          return;
        case 'load':
          // A principal change the router saw, or one the server may have signalled by handing
          // over the very URL it was asked for (it cannot say which): every tab forgets.
          if (verdict.reason === 'another principal' || verdict.url === url) forget();
          win.location.assign(verdict.url);
          return;
        case 'follow':
          await navigate(verdict.url, {
            // Out of a modal, a redirect's target takes the modal's entry: Back never reopens it.
            history: options.history === 'none' || modal.address !== undefined ? 'replace' : 'push',
            hops: hops + 1,
          });
          return;
        case 'hand-over':
          if (answer.body !== null) handOver(win, answer.body, answer.disposition);
          return;
        default:
          break;
      }
      if (next === null) return;
      // A page answered while a modal is open: the modal goes, and so does its history entry.
      const leave = shown === 'page' ? modal.leaveFor(options.history, landed) : undefined;
      const history = leave === undefined ? options.history : leave === 'back' ? 'none' : leave;
      try {
        // Owned from the moment they are appended: a navigation aborted after this point left its
        // sheets in the head for good, styling every page after it — the next swap retires an
        // owned sheet its page does not link.
        await loadStylesheets(doc, missingStylesheets(doc, next), owned);
        if (mine.signal.aborted) return;
        if (shown === 'modal') {
          await modal.present(next, addressOf(landed), landed, modalHistory(method, history));
          doc.dispatchEvent(new CustomEvent(NAVIGATED_EVENT, { detail: { url: landed } }));
          return;
        }
        if (leave === 'back') {
          backing = true;
          win.history.back();
        }
        modal.dismiss();
        let swapped: ReturnType<typeof swapDocument> | undefined;
        await transition(
          win,
          () => {
            // A newer navigation started while the sheets loaded: this answer is no longer asked for.
            if (mine.signal.aborted) return;
            swapped = swapDocument(doc, next, owned);
            // Emptied here and filled after the scripts, so a page with the same title still reads out.
            live.textContent = '';
            swapped.body.append(live);
            rendered = withoutFragment(landed);
            if (history !== 'none') {
              const same = landed === win.location.href || history === 'replace';
              const state = { [STATE_KEY]: { scroll: [0, 0], doc: rendered } satisfies EntryState };
              if (same) win.history.replaceState(state, '', landed);
              else win.history.pushState(state, '', landed);
            }
            // Inside the swap, so a view transition's "after" frame is already where the page lands.
            scrollAfter(win, doc, landed, history);
          },
          press.track,
        );
        const done = swapped;
        if (done === undefined) return;
        if (method === 'POST' && answerMovesTab(facts)) {
          untrusted = true;
          forget();
        }
        await runScripts(done.headScripts, ran, (fresh) => {
          doc.head.append(fresh);
          owned.add(fresh);
        });
        await runScripts([...done.body.querySelectorAll('script')], ran, (fresh, inert) =>
          inert.replaceWith(fresh),
        );
        focusMain(doc);
        live.textContent = doc.title;
        doc.dispatchEvent(new CustomEvent(NAVIGATED_EVENT, { detail: { url: landed } }));
        reconcile();
      } catch {
        // A swap that failed part-way leaves a page nobody rendered: a GET is loaded for real; a
        // POST's answer cannot be asked for again, so the visitor is told and shown this page.
        if (method === 'GET') win.location.assign(landed);
        else failed(url, method, 'the answer could not be shown');
      }
    } finally {
      win.clearTimeout(progress);
      if (inflight === mine) {
        inflight = undefined;
        navigatingTo = undefined;
        doc.documentElement.removeAttribute(NAVIGATING_ATTRIBUTE);
      }
    }
  };

  const onPress = (): void => {
    press.onPress();
    // A press is not a hover: the click it becomes navigates, and a guess on its heels is a
    // second request for the same page.
    win.clearTimeout(intent);
  };

  const onClick = (event: MouseEvent): void => {
    win.clearTimeout(intent);
    if (press.overlayClick(event)) return;
    const anchor = anchorOf(event.target);
    if (anchor === null) return;
    const verdict = linkVerdict(linkFacts(win, anchor, event));
    if (verdict.kind !== 'soft') return;
    event.preventDefault();
    // A link to the page beneath an open modal (its Cancel) closes the modal: nothing is fetched.
    if (modal.address !== undefined && withoutFragment(verdict.url) === rendered) modal.close();
    else void navigate(verdict.url);
  };

  const onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    // An untrusted tab (`answerMovesTab`) leaves every form to the browser.
    if (!(form instanceof HTMLFormElement) || untrusted) return;
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
    win.clearTimeout(intent);
    const delay = event.type === 'pointerover' ? NAVIGATION_PREFETCH_DELAY_MS : 0;
    intent = win.setTimeout(() => prefetch(url), delay);
  };
  const onLeave = (): void => win.clearTimeout(intent);

  /**
   * Back/forward. The router's own entries name the document they show; any other entry (an app's
   * own `pushState`) shows the document of its PATH. Either way, when that is not the document on
   * screen it is fetched; when it is, only the scroll moves — the app keeps its own history.
   */
  const onPop = (event: PopStateEvent): void => {
    scroll.cancel();
    backing = false;
    // The page is the PATH: a modal's hash is the modal's (`reconcile`), never the page's fragment.
    const at = win.location.href;
    const url = modalAddress(new URL(at).hash, at) === null ? at : withoutFragment(at);
    const entry = entryOf(event.state);
    const wanted = entry?.doc ?? withoutFragment(url);
    const same =
      entry !== undefined
        ? wanted === rendered
        : new URL(url).pathname === new URL(rendered).pathname;
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

  /**
   * The modal follows the URL's hash, once the page on screen is the URL's: opened (fetched, as a
   * hash address, so a stale one degrades), kept, or dismissed. On start, on Back/Forward, on a
   * typed hash, and after every page swap — a Back onto a modal's entry swaps its page first.
   */
  function reconcile(): void {
    // Until that Back lands, the hash still names the modal just left: it would be opened again.
    if (backing) return;
    const at = win.location.href;
    if (withoutFragment(at) !== rendered) return;
    const wanted = modalAddress(new URL(at).hash, at);
    if (wanted === null) modal.dismiss();
    else if (wanted !== modal.address) {
      void navigate(new URL(wanted, at).href, { history: 'none', fromHash: true });
    }
  }

  // `window`, bubble phase: after every handler on the page — Solid delegates to `document` — has
  // had its chance to `preventDefault`, which the rules then honour.
  const passive = { passive: true };
  const pressing = { capture: true, passive: true };
  const listeners: readonly (readonly [EventTarget, string, EventListener, object?])[] = [
    [win, 'click', onClick as EventListener],
    [win, 'submit', onSubmit as EventListener],
    [doc, 'pointerover', onIntent, passive],
    [doc, 'pointerout', onLeave, passive],
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

  const router: NavigationRouter = {
    navigate,
    prefetch,
    refresh() {
      // A fresh answer for the page on screen, landing where the visitor is scrolled.
      cache.delete(rendered);
      scroll.save();
      return navigate(rendered, { history: 'none' });
    },
    openModal(path) {
      const address = modalAddress(`#${path}`, win.location.href);
      if (address === null) return Promise.resolve();
      return navigate(new URL(address, win.location.href).href, {
        fromHash: true,
        history: 'push',
      });
    },
    closeModal: () => modal.close(),
    stop() {
      for (const [target, type, listener, options] of listeners) {
        target.removeEventListener(type, listener, options);
      }
      modal.dismiss();
      scroll.stop();
      tabs.stop();
      delete win.__xNavigation;
    },
  };
  win.__xNavigation = router;
  reconcile();
  return router;
}
