// Every branch of the modal controller, where Chrome cannot reach them cheaply or deterministically:
// a fake DOM whose history, dialog events and timing the test drives, so a race the e2e suite meets
// once in twenty runs is a line here that fails on every run. What a real browser does with the
// dialog stays proven in Chrome (`packages/cli/e2e/client-navigation-modal.e2e.test.ts`).
import { afterEach, describe, expect, test } from 'bun:test';
import { startNavigation } from './navigation';
import {
  click,
  currentRouter,
  fire,
  type Handler,
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
  routerHead,
  settle,
} from './navigation-dom-fixture';
import { NAVIGATED_EVENT, NAVIGATION_ERROR_EVENT } from './navigation-rules';

afterEach(stopRouter);

/** A `navigation: 'modal'` page: a heading, a relative link, an action-less form, an island. */
const modalPage = (title: string, extra: FakeElement[] = [], heading = true) => {
  const form = h('form', { id: 'create', method: 'post' }) as FakeForm;
  form.fields = [['name', 'ada']];
  const island = h('div', { 'data-x-island': `i-${title}` });
  return new FakeDocument(
    routerHead(title, [h('meta', { name: 'ultimate-presentation', content: 'modal' })]),
    [
      h('nav', {}, [h('a', { id: 'nav-outside', href: '/elsewhere' }, 'outside')]),
      h('main', {}, [
        ...(heading ? [h('h1', {}, title)] : []),
        h('a', { id: 'step', href: '?step=2' }, 'step'),
        h('a', { id: 'beneath', href: '/a' }, 'cancel'),
        h('a', { id: 'deeper', href: '/m/deeper' }, 'deeper'),
        h('a', { id: 'away', href: '/b' }, 'away'),
        h('a', { id: 'frag', href: '#x' }, 'frag'),
        form,
        island,
        ...extra,
      ]),
      h('script', {}, `hydrate(${title})`),
    ],
  );
};

const modal = (win: FakeWindow) =>
  win.document.querySelector('dialog') as (FakeElement & { open: boolean }) | null;

const ROUTES: Record<string, Handler> = {
  '/m': () => htmlAnswer('modal:M', modalPage('M')),
  '/m/deeper': () => htmlAnswer('modal:Deeper', modalPage('Deeper')),
  '/a': () => htmlAnswer('page:A2', page('A again')),
  '/b': () => htmlAnswer('page:B', page('B')),
  '/plain': () => htmlAnswer('page:Plain', page('Plain')),
};

const pageA = () => page('A', {}, [h('a', { id: 'to-m', href: '/m' }, 'm')]);

/** A page at `/a` with a link to the modal route, and the answers a test needs. */
const open = (routes: Record<string, Handler> = {}) => tab({ ...ROUTES, ...routes }, pageA());

/** A FULL load of `url` — a reload or a pasted address — the router started on it. */
function cold(url: string) {
  const calls: string[] = [];
  const win = fakeWindow(pageA(), url, (to: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(to).pathname} soft`);
    const handler = ROUTES[new URL(to).pathname];
    return handler === undefined
      ? Promise.reject(new TypeError('network'))
      : Promise.resolve(handler(init));
  });
  startNavigation(win as unknown as Window);
  return { win, calls };
}

describe('opening', () => {
  test('a link to a modal page opens it over the page: one dialog, the hash, its own URLs', async () => {
    const { win, doc, calls } = open();
    const landed: string[] = [];
    doc.addEventListener(NAVIGATED_EVENT, (e) => landed.push((e as CustomEvent).detail.url));
    const opener = doc.getElementById('to-m');
    opener?.focus();
    click(win, 'to-m');
    await settle();
    const dialog = modal(win);
    expect(calls).toEqual(['GET /m soft']);
    expect(dialog?.open).toBe(true);
    expect(dialog?.hasAttribute('data-x-modal')).toBe(true);
    expect(win.location.href).toBe('https://app.test/a#/m');
    expect(win.history.state).toEqual({
      __x: { scroll: [0, 0], doc: 'https://app.test/a', modal: '/m' },
    });
    expect(doc.title).toBe('M');
    expect(doc.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'M',
    );
    // Only `<main>` came over; links and the action-less form resolve against the modal's URL.
    expect(dialog?.querySelector('nav')).toBeNull();
    expect(doc.getElementById('step')?.getAttribute('href')).toBe('https://app.test/m?step=2');
    expect(doc.getElementById('frag')?.getAttribute('href')).toBe('#x');
    expect(doc.getElementById('create')?.getAttribute('action')).toBe('https://app.test/m');
    expect(doc.ran).toContain('hydrate(M)');
    // The page beneath is untouched.
    expect(doc.querySelector('h1')?.textContent).toBe('A');
    expect(landed).toEqual(['https://app.test/m']);
  });

  test('a modal page with no heading is named by its title', async () => {
    const { win } = open({ '/m': () => htmlAnswer('modal:Bare', modalPage('Bare', [], false)) });
    click(win, 'to-m');
    await settle();
    expect(modal(win)?.getAttribute('aria-label')).toBe('Bare');
  });

  test('a link to another modal from inside replaces the content in the same dialog, pushed', async () => {
    const { win, doc } = open();
    click(win, 'to-m');
    await settle();
    const first = modal(win);
    click(win, 'deeper');
    await settle();
    expect(doc.querySelectorAll('dialog')).toHaveLength(1);
    expect(modal(win)).toBe(first);
    expect(modal(win)?.querySelector('h1')?.textContent).toBe('Deeper');
    expect(win.location.href).toBe('https://app.test/a#/m/deeper');
    expect(win.entries).toHaveLength(3);
  });

  test('replacing the content never reads its own close as the visitor closing', async () => {
    const { win } = open();
    click(win, 'to-m');
    await settle();
    const dialog = modal(win);
    if (dialog === null) return expect.unreachable('the modal opened');
    // An engine that fires `close` at once, inside `close()`.
    dialog.close = function closeNow(this: FakeElement & { open: boolean }) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    click(win, 'deeper');
    await settle();
    expect(modal(win)?.open).toBe(true);
    expect(modal(win)?.querySelector('h1')?.textContent).toBe('Deeper');
    expect(win.location.href).toBe('https://app.test/a#/m/deeper');
  });

  test('a reload of the address reopens it; a hash naming no modal is dropped in place', async () => {
    const { win, calls } = cold('https://app.test/a#/m');
    await settle();
    expect(calls).toEqual(['GET /m soft']);
    expect(modal(win)?.open).toBe(true);
    (win as unknown as { __xNavigation: { stop(): void } }).__xNavigation.stop();

    const { win: stale } = cold('https://app.test/a#/plain');
    await settle();
    expect(modal(stale)).toBeNull();
    expect(stale.location.href).toBe('https://app.test/a');
    (stale as unknown as { __xNavigation: { stop(): void } }).__xNavigation.stop();
  });
});

describe('closing', () => {
  test('Escape through the entry the router pushed is Back: dismissed, title and focus restored', async () => {
    const { win, doc, calls } = open();
    doc.getElementById('to-m')?.focus();
    click(win, 'to-m');
    await settle();
    const event = new Event('cancel', { cancelable: true });
    modal(win)?.dispatchEvent(event);
    // A second Escape while that Back is traversing does not go Back twice.
    modal(win)?.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(modal(win)).toBeNull();
    expect(win.index).toBe(0);
    expect(win.location.href).toBe('https://app.test/a');
    expect(doc.title).toBe('A');
    expect(doc.activeElement?.id).toBe('to-m');
    expect(calls).toEqual(['GET /m soft']);
  });

  test('a cold-loaded address closes in place: Back would leave the app', async () => {
    const { win } = cold('https://app.test/a#/m');
    await settle();
    modal(win)?.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle();
    expect(modal(win)).toBeNull();
    expect(win.entries).toHaveLength(1);
    expect(win.location.href).toBe('https://app.test/a');
    (win as unknown as { __xNavigation: { stop(): void } }).__xNavigation.stop();
  });

  test('a native close (a method="dialog" form) closes it the same way', async () => {
    const { win } = open();
    click(win, 'to-m');
    await settle();
    const dialog = modal(win);
    dialog?.close();
    await settle();
    expect(modal(win)).toBeNull();
    expect(win.location.href).toBe('https://app.test/a');
  });

  test('a link to the page beneath closes it with nothing fetched', async () => {
    const { win, calls } = open();
    click(win, 'to-m');
    await settle();
    click(win, 'beneath');
    await settle();
    expect(modal(win)).toBeNull();
    expect(calls).toEqual(['GET /m soft']);
  });

  test('a link to another page swaps it in, in place of the modal entry', async () => {
    const { win, doc } = open();
    click(win, 'to-m');
    await settle();
    click(win, 'away');
    await settle();
    expect(modal(win)).toBeNull();
    expect(doc.title).toBe('B');
    expect(win.entries.map((e) => e.url)).toEqual(['https://app.test/a', 'https://app.test/b']);
  });
});

describe('a form inside', () => {
  const submit = (win: FakeWindow) =>
    fire(win, 'submit', win.document.getElementById('create'), { submitter: null });

  test('a re-render is shown in the same dialog, the address replaced', async () => {
    const { win, calls } = open({
      '/m': (init) =>
        init?.method === 'POST'
          ? htmlAnswer('modal:Refused', modalPage('Refused'), { status: 422 })
          : htmlAnswer('modal:M', modalPage('M')),
    });
    click(win, 'to-m');
    await settle();
    submit(win);
    await settle();
    expect(calls).toEqual(['GET /m soft', 'POST /m soft']);
    expect(modal(win)?.querySelector('h1')?.textContent).toBe('Refused');
    expect(win.entries).toHaveLength(2);
    expect(win.location.href).toBe('https://app.test/a#/m');
  });

  test('a redirect to the page beneath closes it through Back and refreshes that page', async () => {
    const { win, doc, calls } = open({
      '/m': (init) =>
        init?.method === 'POST'
          ? new Response(null, { status: 204, headers: { 'x-ultimate-location': '/a' } })
          : htmlAnswer('modal:M', modalPage('M')),
    });
    click(win, 'to-m');
    await settle();
    submit(win);
    await settle();
    expect(calls).toEqual(['GET /m soft', 'POST /m soft', 'GET /a soft']);
    expect(modal(win)).toBeNull();
    expect(doc.title).toBe('A again');
    // Back to the entry beneath — never reopened by the hash it left.
    expect(win.index).toBe(0);
    expect(win.location.href).toBe('https://app.test/a');
  });

  test('once that Back has landed, the hash drives the modal again', async () => {
    const { win, calls } = open({
      '/m': (init) =>
        init?.method === 'POST'
          ? new Response(null, { status: 204, headers: { 'x-ultimate-location': '/a' } })
          : htmlAnswer('modal:M', modalPage('M')),
    });
    click(win, 'to-m');
    await settle();
    submit(win);
    await settle();
    // A hash typed over the page afterwards: held only while the router's own Back traversed.
    win.history.pushState(null, '', 'https://app.test/a#/m');
    win.dispatchEvent(new Event('hashchange'));
    await settle();
    expect(modal(win)?.open).toBe(true);
    expect(calls.at(-1)).toBe('GET /m soft');
  });

  test('a POST that fails on the network reloads the page and its modal', async () => {
    const { win } = open({
      '/m': (init) =>
        init?.method === 'POST'
          ? Promise.reject(new TypeError('network'))
          : htmlAnswer('modal:M', modalPage('M')),
    });
    const errors: string[] = [];
    win.document.addEventListener(NAVIGATION_ERROR_EVENT, (e) =>
      errors.push((e as CustomEvent).detail.method),
    );
    click(win, 'to-m');
    await settle();
    submit(win);
    await settle();
    expect(errors).toEqual(['POST']);
    expect(win.assigned).toEqual(['reload']);
  });
});

describe('from code', () => {
  test('openModal, closeModal, and refresh of the page on screen', async () => {
    const { win, doc, calls } = open();
    await currentRouter()?.openModal('/m');
    expect(modal(win)?.open).toBe(true);
    expect(win.location.href).toBe('https://app.test/a#/m');
    currentRouter()?.closeModal();
    await settle();
    expect(modal(win)).toBeNull();
    // An address no hash names opens nothing and fetches nothing.
    await currentRouter()?.openModal('//evil.test/x');
    await currentRouter()?.refresh();
    expect(doc.title).toBe('A again');
    expect(win.location.href).toBe('https://app.test/a');
    expect(calls).toEqual(['GET /m soft', 'GET /a soft']);
  });

  test('stop() takes an open modal down with the router', async () => {
    const { win } = open();
    click(win, 'to-m');
    await settle();
    stopRouter();
    expect(modal(win)).toBeNull();
  });
});
