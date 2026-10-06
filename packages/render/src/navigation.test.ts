// The controller over the fake DOM and a `fetch` the test answers — every verdict, forms, the
// prefetch cache, real input, history, a failed swap, `stop()`. Chrome: `client-navigation-*.e2e`.
import { afterEach, describe, expect, test } from 'bun:test';
import { notifyClientWrite, rescope } from '@ultimat3/core/page';
import { startNavigation } from './navigation';
import {
  answers,
  click,
  currentRouter,
  fire,
  page,
  stopRouter,
  tab,
} from './navigation-controller-fixture';
import {
  FakeDocument,
  type FakeElement,
  type FakeForm,
  type FakeWindow,
  fakeWindow,
  h,
  htmlAnswer,
  settle,
} from './navigation-dom-fixture';
import { NAVIGATE_EVENT, NAVIGATED_EVENT, NAVIGATION_ERROR_EVENT } from './navigation-rules';

afterEach(stopRouter);

describe('startNavigation', () => {
  test('a document that did not opt in is left alone; a second start is the same router', () => {
    const bare = new FakeDocument();
    expect(
      startNavigation(
        fakeWindow(bare, 'https://app.test/', () =>
          Promise.reject(new TypeError('x')),
        ) as unknown as Window,
      ),
    ).toBeUndefined();
    const { win } = tab({});
    expect(startNavigation(win as unknown as Window)).toBe(currentRouter());
  });
});

describe('a click', () => {
  test('swaps the page in: title, body, history entry, scripts, focus, announcement, event', async () => {
    const { win, doc, calls } = tab({ '/b': answers.b });
    const landed: string[] = [];
    doc.addEventListener(NAVIGATED_EVENT, (e) => landed.push((e as CustomEvent).detail.url));
    const event = click(win, 'to-b');
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(calls).toEqual(['GET /b soft']);
    expect(doc.title).toBe('B');
    expect(win.location.href).toBe('https://app.test/b');
    expect(win.history.state).toEqual({ __x: { scroll: [0, 0], doc: 'https://app.test/b' } });
    expect(doc.ran).toContain('hydrate(B)');
    expect(doc.activeElement?.tagName).toBe('MAIN');
    expect(doc.body.querySelector('[aria-live]')?.textContent).toBe('B');
    expect(landed).toEqual(['https://app.test/b']);
  });

  test('left to the browser: a modifier, a non-link; cancelled by a navigate listener', async () => {
    const { win, doc, calls } = tab({ '/b': answers.b });
    expect(click(win, 'to-b', { metaKey: true }).defaultPrevented).toBe(false);
    fire(win, 'click', doc.querySelector('h1'));
    doc.addEventListener(NAVIGATE_EVENT, (e) => e.preventDefault(), { once: true });
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual([]);
  });

  test('shows progress past 150 ms, and a newer click cancels the slower answer', async () => {
    let release = (_r: Response): void => undefined;
    const { win, doc } = tab({
      '/slow': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      '/b': answers.b,
    });
    click(win, 'to-slow');
    await new Promise((r) => setTimeout(r, 200));
    expect(doc.documentElement.hasAttribute('data-x-navigating')).toBe(true);
    click(win, 'to-b');
    await settle();
    release(htmlAnswer('page:Slow', page('Slow')));
    await settle();
    expect(doc.title).toBe('B');
    expect(doc.documentElement.hasAttribute('data-x-navigating')).toBe(false);
  });
});

describe('what the answer says', () => {
  const hand =
    (location: string | null, status = 204) =>
    () =>
      new Response(null, {
        status,
        headers: location === null ? {} : { 'x-ultimate-location': location },
      });

  test('an empty 204 stays; a hand-over of the same URL is a real load and every tab forgets', async () => {
    const { win, doc } = tab({ '/b': hand(null), '/c': hand('/c') });
    click(win, 'to-b');
    await settle();
    expect([doc.title, win.assigned]).toEqual(['A', []]);
    click(win, 'to-c');
    await settle();
    expect(win.assigned).toEqual(['https://app.test/c']);
  });

  test('a hand-over to another URL is followed as the next request', async () => {
    const { win, doc, calls } = tab({ '/b': hand('/c'), '/c': answers.c });
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual(['GET /b soft', 'GET /c soft']);
    expect([doc.title, win.location.href]).toEqual(['C', 'https://app.test/c']);
  });

  test('not a page: handed over from the bytes received; a failed network: the browser loads it', async () => {
    const { win } = tab({
      '/b': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    });
    click(win, 'to-b');
    await settle();
    expect(win.assigned[0]?.startsWith('blob:')).toBe(true);
    click(win, 'to-c');
    await settle();
    expect(win.assigned[1]).toBe('https://app.test/c');
  });

  test('another principal or another build: a real load', async () => {
    const { win } = tab({
      '/b': () => htmlAnswer('page:B-other', page('B', { scope: 'member:2' })),
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
    expect(win.assigned).toEqual(['https://app.test/b', 'https://app.test/c']);
  });

  test('a swap that throws part-way is a real load, never a half-replaced page', async () => {
    const { win, doc } = tab({ '/b': answers.b });
    doc.adoptNode = () => {
      throw new TypeError('broken');
    };
    click(win, 'to-b');
    await settle();
    expect(win.assigned).toEqual(['https://app.test/b']);
  });
});

// `hops >= NAVIGATION_MAX_HOPS` is the only exit from a redirect chain, and `NaN >= 5` is false:
// `navigate(url, { hops: NaN })` followed a loop for ever. Now a non-count is an exhausted chain.
describe('the redirect bound', () => {
  const to = (location: string) => () =>
    new Response(null, { status: 204, headers: { 'x-ultimate-location': location } });

  test('a hops that is not a whole count is an exhausted chain: one request, then the browser', async () => {
    const { win, calls } = tab({ '/b': to('/c'), '/c': to('/b') });
    const router = currentRouter() ?? expect.unreachable('the fixture starts a router');
    for (const hops of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      await router.navigate('https://app.test/b', { hops });
    }
    // Each call: its one request, then a hand-over — never a follow, so never a loop.
    expect(calls).toHaveLength(4);
    expect(win.assigned).toHaveLength(4);
  });

  test('a redirect loop stops at the max and is handed to the browser', async () => {
    const { win, calls } = tab({ '/b': to('/c'), '/c': to('/b') });
    click(win, 'to-b');
    await settle();
    // The first request, then NAVIGATION_MAX_HOPS (5) follows, then the browser takes it.
    expect(calls).toHaveLength(6);
    expect(win.assigned).toHaveLength(1);
  });
});

describe('forms', () => {
  const form = (attrs: Record<string, string>, fields: [string, string][]) => {
    const f = h('form', { id: 'f', ...attrs }) as FakeForm;
    f.fields = fields;
    return f;
  };
  const submit = (win: FakeWindow, submitter: FakeElement | null = null) =>
    fire(win, 'submit', win.document.getElementById('f'), { submitter });

  test("a GET navigates to its query; a target is the browser's", async () => {
    const { win, calls } = tab(
      { '/search': () => htmlAnswer('page:S', page('S')) },
      page('A', {}, [form({ action: '/search' }, [['q', 'x']])]),
    );
    const f = win.document.getElementById('f') as FakeElement;
    f.setAttribute('target', '_blank');
    expect(submit(win).defaultPrevented).toBe(false);
    f.removeAttribute('target');
    expect(submit(win).defaultPrevented).toBe(true);
    await settle();
    expect(calls).toEqual(['GET /search?q=x soft']);
  });

  test('a POST is sent once with its fields and the submitter; its 303 is followed', async () => {
    let body = '';
    const { win, doc, calls } = tab(
      {
        '/send': (init) => {
          body = String(init?.body);
          return hand303();
        },
        '/done': () => htmlAnswer('page:Done', page('Done')),
      },
      page('A', {}, [form({ method: 'post', action: '/send' }, [['name', 'ada']])]),
    );
    submit(win, h('button', { name: 'go', value: '1' }));
    await settle();
    expect(calls).toEqual(['POST /send soft', 'GET /done soft']);
    expect(body).toBe('name=ada&go=1');
    expect(doc.title).toBe('Done');
  });

  test('a multipart POST sends the FormData itself', async () => {
    let sent: unknown;
    const { win } = tab(
      {
        '/send': (init) => {
          sent = init?.body;
          return new Response(null, { status: 204 });
        },
      },
      page('A', {}, [
        form({ method: 'post', action: '/send', enctype: 'multipart/form-data' }, [['a', '1']]),
      ]),
    );
    submit(win);
    await settle();
    expect(sent).toBeInstanceOf(FormData);
  });

  test('a POST that fails is never re-sent: the error event, whose default loads this page', async () => {
    const { win, doc, calls } = tab(
      {},
      page('A', {}, [form({ method: 'post', action: '/send' }, [])]),
    );
    const reasons: string[] = [];
    doc.addEventListener(NAVIGATION_ERROR_EVENT, (e) =>
      reasons.push((e as CustomEvent).detail.reason),
    );
    submit(win);
    await settle();
    expect(calls).toEqual(['POST /send soft']);
    expect(reasons).toEqual(['the request failed on the network']);
    expect(win.assigned).toEqual(['https://app.test/a']);
    doc.addEventListener(NAVIGATION_ERROR_EVENT, (e) => e.preventDefault());
    submit(win);
    await settle();
    expect(win.assigned).toHaveLength(1);
  });

  test('an opaque redirect or a failed swap after a POST is the error event, never a resubmit', async () => {
    const { win, doc } = tab(
      {
        '/send': () =>
          ({ type: 'opaqueredirect', status: 0, headers: new Headers() }) as unknown as Response,
      },
      page('A', {}, [form({ method: 'post', action: '/send' }, [])]),
    );
    const reasons: string[] = [];
    doc.addEventListener(NAVIGATION_ERROR_EVENT, (e) => {
      e.preventDefault();
      reasons.push((e as CustomEvent).detail.reason);
    });
    submit(win);
    await settle();
    expect(reasons).toEqual(['a redirect no framework server handed over']);
  });

  test('a POST answered in place for another principal: shown, then every navigation is real', async () => {
    const { win, doc, calls } = tab(
      {
        '/send': () => htmlAnswer('page:Other', page('Other', { scope: 'member:2' }), {}),
        '/b': answers.b,
      },
      page('A', {}, [form({ method: 'post', action: '/send' }, [])]),
    );
    submit(win);
    await settle();
    expect(doc.title).toBe('Other');
    click(win, 'to-b');
    fire(doc, 'focusin', doc.getElementById('to-c'));
    await settle();
    expect(win.assigned).toEqual(['https://app.test/b']);
    expect(calls).toEqual(['POST /send soft']);
    const f = form({ method: 'post', action: '/send' }, []);
    doc.body.append(f);
    expect(submit(win).defaultPrevented).toBe(false);
  });
});

const hand303 = () =>
  new Response(null, { status: 204, headers: { 'x-ultimate-location': '/done' } });

describe('prefetch and its cache', () => {
  test('a resting pointer fetches once; the click reuses it; leaving early fetches nothing', async () => {
    const { win, doc, calls } = tab({ '/b': answers.b, '/c': answers.c });
    fire(doc, 'pointerover', doc.getElementById('to-c'));
    fire(doc, 'pointerout', doc.getElementById('to-c'));
    fire(doc, 'pointerover', doc.getElementById('to-b'));
    await new Promise((r) => setTimeout(r, 120));
    fire(doc, 'pointerover', doc.getElementById('to-b'));
    await new Promise((r) => setTimeout(r, 120));
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual(['GET /b prefetch']);
    expect(doc.title).toBe('B');
  });

  test('never: data-x-no-prefetch, Save-Data, a link the browser keeps', async () => {
    const { win, doc, calls } = tab({ '/b': answers.b });
    fire(doc, 'focusin', doc.getElementById('plain'));
    fire(doc, 'touchstart', doc.querySelector('h1'));
    win.navigator.connection = { saveData: true };
    fire(doc, 'focusin', doc.getElementById('to-b'));
    await settle();
    expect(calls).toEqual([]);
  });

  test('a client write, a rescope and another tab each empty it; a refused guess is not reused', async () => {
    const { win, doc, calls } = tab({
      '/b': answers.b,
      '/c': () => new Response(null, { status: 204 }),
    });
    const warm = async () => {
      fire(doc, 'focusin', doc.getElementById('to-b'));
      await settle();
    };
    await warm();
    notifyClientWrite('/api/x');
    await warm();
    rescope('member:9');
    await warm();
    new BroadcastChannel('ultimate:navigation').postMessage('clear');
    await settle(20);
    await warm();
    expect(calls.filter((c) => c === 'GET /b prefetch')).toHaveLength(4);
    fire(doc, 'focusin', doc.getElementById('to-c'));
    await settle();
    click(win, 'to-c');
    await settle();
    expect(calls.slice(-2)).toEqual(['GET /c prefetch', 'GET /c soft']);
  });
});

describe('history and scroll', () => {
  test('back swaps the previous page in and restores its scroll; the same page only scrolls', async () => {
    const { win, doc, calls } = tab({
      '/a': () => htmlAnswer('page:A2', page('A')),
      '/b': answers.b,
    });
    win.scrollY = 800;
    fire(win, 'scroll', win);
    await new Promise((r) => setTimeout(r, 200));
    click(win, 'to-b');
    await settle();
    win.go(-1);
    await settle();
    expect(calls).toEqual(['GET /b soft', 'GET /a soft']);
    expect([doc.title, win.scrollY]).toEqual(['A', 800]);
    win.history.replaceState({ __x: { scroll: [0, 40], doc: 'https://app.test/a' } }, '');
    win.go(0);
    expect(win.scrollY).toBe(40);
  });

  test("an entry the app pushed shows its path's page; on this path it is the app's", async () => {
    const { win, calls } = tab({ '/b': answers.b, '/a': () => htmlAnswer('page:A3', page('A')) });
    win.history.pushState({ app: 1 }, '', 'https://app.test/a?tab=2');
    win.go(0);
    await settle();
    expect(calls).toEqual([]);
    click(win, 'to-b');
    await settle();
    win.go(-1);
    await settle();
    expect(calls).toEqual(['GET /b soft', 'GET /a?tab=2 soft']);
  });
});

describe('stop', () => {
  test('lets go of every listener', async () => {
    const { win, calls } = tab({ '/b': answers.b });
    stopRouter();
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual([]);
    expect(win.__xNavigation).toBeUndefined();
  });
});
