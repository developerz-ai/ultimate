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
 * Loaded as one deferred classic script (`@ultimat3/cli` builds it to `/_x/navigation/<hash>.js`)
 * on documents whose surface opted in (`navigation: { client: [...] }` in `app.config.ts`).
 */

import { CLIENT_BUILD_META, CLIENT_SCOPE_META } from '@ultimat3/core/page';
import { navigationCache } from './navigation-cache';
import {
  anchorOf,
  announcer,
  focusMain,
  formAction,
  formFields,
  formPairs,
  handOver,
  linkFacts,
  type RunningTransition,
  transition,
} from './navigation-dom';
import { type Answer, fetchDocument, metaOf } from './navigation-fetch';
import {
  type EntryState,
  entryOf,
  STATE_KEY,
  scrollAfter,
  withoutFragment,
} from './navigation-history';
import {
  answerMovesTab,
  type FormFacts,
  formVerdict,
  linkVerdict,
  mayPrefetch,
  NAVIGATE_EVENT,
  NAVIGATED_EVENT,
  NAVIGATING_ATTRIBUTE,
  NAVIGATION_ERROR_EVENT,
  NAVIGATION_META,
  NAVIGATION_NO_PREFETCH_ATTRIBUTE,
  NAVIGATION_PREFETCH_DELAY_MS,
  NAVIGATION_PROGRESS_DELAY_MS,
  NAVIGATION_RELOAD_ATTRIBUTE,
  type ResponseFacts,
  responseVerdict,
  reusable,
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
}

export interface NavigationRouter {
  navigate(url: string, options?: NavigateOptions): Promise<void>;
  prefetch(url: string): void;
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
  /** The view transition still animating, which a press skips to the new page. */
  let animating: RunningTransition | undefined;
  /** Between a press and its click: the focus the press gives a link is not a hover. */
  let pressed = false;
  /** The press landed while a transition was painting over the page (see `onClick`). */
  let pressedOverTransition = false;
  /** The pending prefetch of a hover, cancelled by anything that navigates. */
  let intent: number | undefined;
  let untrusted = false;
  let inflight: AbortController | undefined;
  const live = announcer(doc);
  const owned = documentHead(doc);
  notePersisted(doc);
  const tabs = tabSync(win, () => cache.clear());
  const forget = tabs.forget;
  const scroll = scrollKeeper(win, () => rendered);

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
    if (doc.dispatchEvent(event)) win.location.assign(win.location.href);
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
    const held = cache.peek(url);
    cache.delete(url);
    if (held === undefined) return request(url, 'soft', { signal });
    return held.value.then(
      (answer) =>
        reusable({
          status: answer.status,
          html: answer.html !== null,
          location: answer.location,
          noStore: answer.noStore,
          ageMs: held.ageMs,
        })
          ? answer
          : request(url, 'soft', { signal }),
      () => request(url, 'soft', { signal }),
    );
  };

  const navigate = async (url: string, options: NavigateOptions = {}): Promise<void> => {
    const method = options.method ?? 'GET';
    // After an answer for another principal or build was shown in place, this tab is no longer
    // trusted to swap: every navigation is a real load (`answerMovesTab`).
    if (untrusted && method === 'GET') {
      win.location.assign(url);
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
      const facts: ResponseFacts = {
        method,
        requested: url,
        status: answer.status,
        opaqueRedirect: answer.opaqueRedirect,
        location: answer.location,
        contentType: answer.contentType,
        hops: options.hops ?? 0,
        surface: metaOf(doc, NAVIGATION_META),
        nextSurface: next === null ? null : metaOf(next, NAVIGATION_META),
        build: metaOf(doc, CLIENT_BUILD_META),
        nextBuild: answer.build ?? (next === null ? null : metaOf(next, CLIENT_BUILD_META)),
        scope: metaOf(doc, CLIENT_SCOPE_META),
        nextScope: next === null ? null : metaOf(next, CLIENT_SCOPE_META),
      };
      const verdict = responseVerdict(facts);
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
            history: options.history === 'none' ? 'replace' : 'push',
            hops: (options.hops ?? 0) + 1,
          });
          return;
        case 'hand-over':
          if (answer.body !== null) handOver(win, answer.body, answer.disposition);
          return;
        default:
          break;
      }
      if (next === null) return;
      const landed = `${withoutFragment(url)}${new URL(url).hash}`;
      try {
        // Owned from the moment they are appended: a navigation aborted after this point left its
        // sheets in the head for good, styling every page after it — the next swap retires an
        // owned sheet its page does not link.
        await loadStylesheets(doc, missingStylesheets(doc, next), owned);
        if (mine.signal.aborted) return;
        let swapped: ReturnType<typeof swapDocument> | undefined;
        const track = (running: RunningTransition, finished: boolean): void => {
          if (!finished) animating = running;
          else if (animating === running) animating = undefined;
        };
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
            if (options.history !== 'none') {
              const same = landed === win.location.href || options.history === 'replace';
              const state = { [STATE_KEY]: { scroll: [0, 0], doc: rendered } satisfies EntryState };
              if (same) win.history.replaceState(state, '', landed);
              else win.history.pushState(state, '', landed);
            }
            // Inside the swap, so a view transition's "after" frame is already where the page lands.
            scrollAfter(win, doc, landed, options.history);
          },
          track,
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
    pressed = true;
    pressedOverTransition = animating !== undefined;
    // A press is not a hover: the click it becomes navigates, and a guess on its heels is a
    // second request for the same page. And a press during the animation skips to the new page.
    win.clearTimeout(intent);
    animating?.skipTransition?.();
  };
  const onRelease = (): void => {
    pressed = false;
  };

  const onClick = (event: MouseEvent): void => {
    win.clearTimeout(intent);
    // While a view transition paints, the browser hit-tests every press to `<html>`: the press
    // skipped the animation (`onPress`), the release landed on the real element, and the click —
    // aimed at their common ancestor — reached nothing. The visitor's first click after a swap was
    // lost. It is given to the element under the pointer NOW, whatever it is: a link, a submit
    // button, an island's own control.
    if (pressedOverTransition && event.target === doc.documentElement) {
      pressedOverTransition = false;
      const hit = doc.elementFromPoint(event.clientX, event.clientY);
      if (hit !== null && hit !== doc.documentElement && hit instanceof HTMLElement) hit.click();
      return;
    }
    const anchor = anchorOf(event.target);
    if (anchor === null) return;
    const verdict = linkVerdict(linkFacts(win, anchor, event));
    if (verdict.kind !== 'soft') return;
    event.preventDefault();
    void navigate(verdict.url);
  };

  const onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    // An untrusted tab (`answerMovesTab`) leaves every form to the browser.
    if (!(form instanceof HTMLFormElement) || untrusted) return;
    const submitter = event.submitter;
    const fields = formFields(form, submitter);
    const say = (attr: string, fallback: string): string =>
      submitter?.getAttribute(`form${attr}`) ?? form.getAttribute(attr) ?? fallback;
    const facts: FormFacts = {
      action: formAction(say('action', ''), win.location.href, doc.baseURI),
      current: win.location.href,
      method: say('method', 'get').toLowerCase(),
      enctype: say('enctype', 'application/x-www-form-urlencoded').toLowerCase(),
      target: say('target', ''),
      defaultPrevented: event.defaultPrevented,
      reload:
        form.hasAttribute(NAVIGATION_RELOAD_ATTRIBUTE) ||
        submitter?.hasAttribute(NAVIGATION_RELOAD_ATTRIBUTE) === true,
      // `unknown`: a browser yields a `File` for a file input, whatever a server-side type says.
      hasFile: [...fields.values()].some(
        (value: unknown) => value instanceof File && value.name !== '',
      ),
      fields: formPairs(fields),
    };
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
    if (event.type === 'focusin' && pressed) return;
    const anchor = anchorOf(event.target);
    if (anchor === null) return;
    const verdict = linkVerdict(linkFacts(win, anchor));
    const connection = (
      win.navigator as { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection;
    if (
      verdict.kind !== 'soft' ||
      !mayPrefetch({
        url: verdict.url,
        noPrefetch: anchor.hasAttribute(NAVIGATION_NO_PREFETCH_ATTRIBUTE),
        saveData: connection?.saveData,
        effectiveType: connection?.effectiveType,
      })
    ) {
      return;
    }
    win.clearTimeout(intent);
    const delay = event.type === 'pointerover' ? NAVIGATION_PREFETCH_DELAY_MS : 0;
    intent = win.setTimeout(() => prefetch(verdict.url), delay);
  };
  const onLeave = (): void => win.clearTimeout(intent);

  /**
   * Back/forward. The router's own entries name the document they show; any other entry (an app's
   * own `pushState`) shows the document of its PATH. Either way, when that is not the document on
   * screen it is fetched; when it is, only the scroll moves — the app keeps its own history.
   */
  const onPop = (event: PopStateEvent): void => {
    scroll.cancel();
    const url = win.location.href;
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
  };

  // `window`, bubble phase: after every handler on the page — Solid delegates to `document` — has
  // had its chance to `preventDefault`, which the rules then honour.
  win.addEventListener('click', onClick);
  win.addEventListener('submit', onSubmit);
  doc.addEventListener('pointerover', onIntent, { passive: true });
  doc.addEventListener('pointerout', onLeave, { passive: true });
  doc.addEventListener('focusin', onIntent);
  doc.addEventListener('touchstart', onIntent, { passive: true });
  win.addEventListener('popstate', onPop);
  doc.addEventListener('pointerdown', onPress, { capture: true, passive: true });
  doc.addEventListener('pointerup', onRelease, { capture: true, passive: true });
  doc.addEventListener('pointercancel', onRelease, { capture: true, passive: true });

  const router: NavigationRouter = {
    navigate,
    prefetch,
    stop() {
      win.removeEventListener('click', onClick);
      win.removeEventListener('submit', onSubmit);
      doc.removeEventListener('pointerover', onIntent);
      doc.removeEventListener('pointerout', onLeave);
      doc.removeEventListener('focusin', onIntent);
      doc.removeEventListener('touchstart', onIntent);
      win.removeEventListener('popstate', onPop);
      doc.removeEventListener('pointerdown', onPress, { capture: true });
      doc.removeEventListener('pointerup', onRelease, { capture: true });
      doc.removeEventListener('pointercancel', onRelease, { capture: true });
      scroll.stop();
      tabs.stop();
      delete win.__xNavigation;
    },
  };
  win.__xNavigation = router;
  return router;
}
