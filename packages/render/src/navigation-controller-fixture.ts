/**
 * The controller's test harness beside the fake DOM: a page with the links every test follows, a
 * tab whose `fetch` the test answers (every call recorded), an event dispatched the way a browser
 * does, and the router the test started — stopped after each by `stopRouter()`.
 */
import { startNavigation } from './navigation';
import {
  FakeDocument,
  type FakeElement,
  type FakeWindow,
  fakeWindow,
  h,
  htmlAnswer,
  routerHead,
} from './navigation-dom-fixture';

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

export const page = (
  title: string,
  meta: { scope?: string; build?: string } = {},
  body: FakeElement[] = [],
) =>
  new FakeDocument(routerHead(title, [], meta), [
    h('main', {}, [
      h('h1', {}, title),
      h('a', { id: 'to-b', href: '/b' }, 'b'),
      h('a', { id: 'to-c', href: '/c' }, 'c'),
      h('a', { id: 'to-slow', href: '/slow' }, 'slow'),
      h('a', { id: 'plain', href: '/b', 'data-x-no-prefetch': '' }, 'plain'),
      ...body,
    ]),
    h('script', {}, `hydrate(${title})`),
  ]);

/** The router the current test started; `stopRouter()` in an `afterEach` lets it go. */
let router: ReturnType<typeof startNavigation>;
export const currentRouter = (): ReturnType<typeof startNavigation> => router;
export function stopRouter(): void {
  router?.stop();
  router = undefined;
}

/** A tab on `/a` whose `fetch` answers from `routes`; `calls` records `METHOD path purpose`. */
export function tab(routes: Record<string, Handler>, doc = page('A')) {
  const calls: string[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(
      `${init?.method ?? 'GET'} ${u.pathname}${u.search} ${headers['x-ultimate-navigation']}`,
    );
    const handler = routes[u.pathname];
    if (handler === undefined) return Promise.reject(new TypeError('network'));
    return Promise.resolve(handler(init));
  };
  const win = fakeWindow(doc, 'https://app.test/a', fetch);
  router = startNavigation(win as unknown as Window);
  return { win, doc, calls };
}

/** An event the way a browser dispatches it: cancelable, with its target and fields. */
export function fire(
  on: EventTarget,
  type: string,
  target: unknown,
  fields: Record<string, unknown> = {},
): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  for (const [key, value] of Object.entries({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...fields,
  })) {
    Object.defineProperty(event, key, { value });
  }
  on.dispatchEvent(event);
  return event;
}

export const click = (win: FakeWindow, id: string, fields?: Record<string, unknown>) =>
  fire(win, 'click', win.document.getElementById(id), fields);

export const answers = {
  b: () => htmlAnswer('page:B', page('B')),
  c: () => htmlAnswer('page:C', page('C')),
};
