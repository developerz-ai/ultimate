// A streamed soft visit whose body breaks under the page on screen, over the fake DOM: loaded for
// real when nothing else is on its way, left alone for a newer visit that takes the tab, recovered
// once a newer visit stays, and never over a load the router already handed to the browser.
// Chrome: `packages/cli/e2e/stream-hole-recovery.e2e.test.ts`.
import { afterEach, expect, test } from 'bun:test';
import { click, currentRouter, page, stopRouter, tab } from './navigation-controller-fixture';
import { type FakeDocument, htmlAnswer, parsed, settle } from './navigation-dom-fixture';
import { NAVIGATED_EVENT } from './navigation-rules';
import { STREAM_FLUSH_MARK } from './stream-scripts';

afterEach(stopRouter);

/**
 * A page that streams: its shell answers at once, its rest when the test says. The rest the fake
 * parser has never seen is what a body that died mid-chunk is to the router: it cannot be shown.
 */
function streamed(key: string, doc: FakeDocument) {
  parsed.set(key, doc);
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const seen = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(`${key}${STREAM_FLUSH_MARK}`));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    seen,
    /** The torn chunk, unless the router already stopped reading: then there is no one to tear. */
    breakIt: () => {
      if (!seen.cancelled) controller?.enqueue(encoder.encode(`<p>torn${STREAM_FLUSH_MARK}`));
    },
  };
}

/** An answer the test releases: a visit that is still on its way. */
function held(answer: () => Response) {
  let release = (): void => undefined;
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(answer());
  });
  return { response, release };
}

test('a stream that breaks under the page on screen is loaded for real', async () => {
  const s = streamed('page:S', page('S'));
  const { win, doc } = tab({ '/b': () => s.response });
  click(win, 'to-b');
  await settle();
  expect(doc.title).toBe('S');
  s.breakIt();
  await settle();
  expect(win.assigned).toEqual(['https://app.test/b']);
});

test('broken while the next visit is on its way, which then lands: nothing is recovered', async () => {
  const s = streamed('page:S', page('S'));
  const next = held(() => htmlAnswer('page:C', page('C')));
  const { win, doc } = tab({ '/b': () => s.response, '/c': () => next.response });
  click(win, 'to-b');
  await settle();
  click(win, 'to-c');
  await settle();
  s.breakIt();
  await settle();
  expect(win.assigned).toEqual([]);
  next.release();
  await settle();
  expect([doc.title, win.assigned]).toEqual(['C', []]);
});

test('broken while the next visit is on its way, which stays: recovered once it settles', async () => {
  const s = streamed('page:S', page('S'));
  const next = held(() => new Response(null, { status: 204 }));
  const { win } = tab({ '/b': () => s.response, '/c': () => next.response });
  click(win, 'to-b');
  await settle();
  click(win, 'to-c');
  await settle();
  s.breakIt();
  await settle();
  expect(win.assigned).toEqual([]);
  next.release();
  await settle();
  expect(win.assigned).toEqual(['https://app.test/b']);
});

test('a load handed to the browser is never overridden by the page it left breaking', async () => {
  const s = streamed('page:S', page('S'));
  const { win } = tab({
    '/b': () => s.response,
    // Another build: the router hands the tab to the browser, which has not committed the load.
    '/c': () =>
      htmlAnswer('page:skew', page('Refused'), {
        status: 409,
        headers: { 'x-ultimate-build': 'b9' },
      }),
  });
  click(win, 'to-b');
  await settle();
  click(win, 'to-c');
  await settle();
  expect(win.assigned).toEqual(['https://app.test/c']);
  // The page being left stopped reading its holes when the tab was handed over.
  expect(s.seen.cancelled).toBe(true);
  s.breakIt();
  await settle();
  expect(win.assigned).toEqual(['https://app.test/c']);
});

test('Back to a fragment URL whose soft fetch fails is a full load: the address bar already holds it', async () => {
  const { win, doc } = tab({ '/b': () => htmlAnswer('page:B', page('B')) });
  win.history.replaceState(null, '', 'https://app.test/a#filled');
  click(win, 'to-b');
  await settle();
  expect(doc.title).toBe('B');
  // `/a` has no answer: the fetch fails, and `assign` to the URL on screen would only scroll.
  win.go(-1);
  await settle();
  expect([win.location.href, win.assigned]).toEqual(['https://app.test/a#filled', ['reload']]);
});

test('broken after the visitor moved to another fragment: the page asked for is the one reloaded', async () => {
  const s = streamed('page:S', page('S'));
  const { win, doc } = tab({ '/b': () => s.response });
  await currentRouter()?.navigate('https://app.test/b#part');
  await settle();
  expect(doc.title).toBe('S');
  // A fragment link of the page on screen is the browser's: it pushes, and the router never sees it.
  win.history.pushState(null, '', 'https://app.test/b#other');
  s.breakIt();
  await settle();
  // A reload of `/b#other` would never reach `#part`: the requested URL is pushed, as `assign` would.
  expect([win.location.href, win.index, win.assigned]).toEqual([
    'https://app.test/b#part',
    3,
    ['reload'],
  ]);
});

test('a streamed POST for another principal, left by a GET its navigated listener starts: never filled', async () => {
  const s = streamed('page:Other', page('Other', { scope: 'member:2' }));
  const { win, doc } = tab({ '/send': () => s.response });
  // The tab is no longer trusted to swap: the GET is the browser's, and the POST's holes go with it.
  doc.addEventListener(NAVIGATED_EVENT, () => void currentRouter()?.navigate('https://app.test/b'));
  await currentRouter()?.navigate('https://app.test/send', {
    method: 'POST',
    body: new FormData(),
  });
  await settle();
  expect([doc.title, win.assigned, s.seen.cancelled]).toEqual([
    'Other',
    ['https://app.test/b'],
    true,
  ]);
  s.breakIt();
  await settle();
  expect(win.assigned).toEqual(['https://app.test/b']);
});
