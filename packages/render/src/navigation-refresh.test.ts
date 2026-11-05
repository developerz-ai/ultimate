// `refresh()` re-reads the page on screen for the SAME visitor: focus stays where it was, nothing
// is announced, no view transition runs, a click in flight survives and an open modal is left
// alone. Each line here is the probe of plan 101 slice 23, failing before `navigation-refresh.ts`.
// Chrome: `packages/cli/e2e/client-navigation-refresh.e2e.test.ts`.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  click,
  currentRouter,
  type Handler,
  page,
  stopRouter,
  tab,
} from './navigation-controller-fixture';
import {
  FakeDocument,
  type FakeElement,
  h,
  htmlAnswer,
  routerHead,
  settle,
} from './navigation-dom-fixture';

afterEach(stopRouter);

const withInput = (title: string, extra: FakeElement[] = []) =>
  page(title, {}, [h('form', { id: 'search' }, [h('input', { id: 'q', name: 'q' })]), ...extra]);

const modalOf = (title: string) =>
  new FakeDocument(
    routerHead(title, [h('meta', { name: 'ultimate-presentation', content: 'modal' })]),
    [h('main', {}, [h('h1', {}, title)])],
  );

const refreshed = (title: string, extra: FakeElement[] = []): Record<string, Handler> => ({
  '/a': () => htmlAnswer(`page:${title}`, withInput(title, extra)),
});

const refresh = async (): Promise<void> => {
  await currentRouter()?.refresh();
  await settle();
};

describe('refresh()', () => {
  test('focus stays on the control the visitor was in, never moved to <main>', async () => {
    const { doc } = tab(refreshed('A'), withInput('A'));
    doc.getElementById('q')?.focus();
    await refresh();
    expect(doc.activeElement?.tagName).toBe('INPUT');
    expect(doc.activeElement?.id).toBe('q');
    expect(doc.activeElement?.connected).toBe(true);
  });

  test('a control with no id is found by its name in the same form', async () => {
    const field = () => [h('form', { id: 'f' }, [h('input', { name: 'note' })])];
    const { doc } = tab(
      { '/a': () => htmlAnswer('page:named', page('A', {}, field())) },
      page('A', {}, field()),
    );
    doc.querySelector('input')?.focus();
    await refresh();
    expect(doc.activeElement?.getAttribute('name')).toBe('note');
    expect(doc.activeElement?.connected).toBe(true);
  });

  test('a control with neither is found by its row, its tag and its place in the row', async () => {
    const rows = () => [
      h('ul', {}, [
        h('li', { 'data-row': 'r1' }, [h('button', {}, 'edit'), h('button', {}, 'drop')]),
        h('li', { 'data-row': 'r2' }, [h('button', {}, 'edit'), h('button', {}, 'drop')]),
      ]),
    ];
    const { doc } = tab(
      { '/a': () => htmlAnswer('page:rows', page('A', {}, rows())) },
      page('A', {}, rows()),
    );
    doc.querySelectorAll('[data-row]')[1]?.querySelectorAll('button')[1]?.focus();
    await refresh();
    const focused = doc.activeElement;
    expect(focused?.textContent).toBe('drop');
    expect(focused?.parentElement?.getAttribute('data-row')).toBe('r2');
    expect(focused?.connected).toBe(true);
  });

  test('a control gone from the new page hands focus to <main>', async () => {
    const { doc } = tab({ '/a': () => htmlAnswer('page:gone', page('A')) }, withInput('A'));
    doc.getElementById('q')?.focus();
    await refresh();
    expect(doc.activeElement?.tagName).toBe('MAIN');
  });

  test('nothing focused before: focus is not moved', async () => {
    const { doc } = tab(refreshed('A'), withInput('A'));
    await refresh();
    expect(doc.activeElement).toBeNull();
  });

  test('the announcer is not written: the title did not change for this visitor', async () => {
    const { doc } = tab(refreshed('A'), withInput('A'));
    await refresh();
    expect(doc.title).toBe('A');
    expect(doc.body.querySelector('[aria-live]')?.textContent).toBe('');
  });

  test('no view transition: the same page is not a new place', async () => {
    const { doc } = tab(refreshed('A'), withInput('A'));
    let transitions = 0;
    doc.startViewTransition = (update) => {
      transitions += 1;
      update();
      const done = Promise.resolve();
      return { updateCallbackDone: done, ready: done, finished: done };
    };
    await refresh();
    expect(transitions).toBe(0);
  });

  test("a click in flight survives: the refresh does nothing, the visitor's page lands", async () => {
    let release = (_r: Response): void => undefined;
    const { win, doc, calls } = tab({
      ...refreshed('A again'),
      '/slow': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    click(win, 'to-slow');
    await settle();
    await refresh();
    release(htmlAnswer('page:Slow', page('Slow')));
    await settle();
    expect(calls).toEqual(['GET /slow soft']);
    expect(win.location.href).toBe('https://app.test/slow');
    expect(doc.title).toBe('Slow');
  });

  test('an open modal is left alone: neither it nor the page beneath is fetched again', async () => {
    const modalPage = new FakeDocument(
      routerHead('M', [h('meta', { name: 'ultimate-presentation', content: 'modal' })]),
      [h('main', {}, [h('h1', {}, 'M')])],
    );
    const { win, calls } = tab(
      { ...refreshed('A again'), '/m': () => htmlAnswer('modal:M', modalPage) },
      page('A', {}, [h('a', { id: 'to-m', href: '/m' }, 'm')]),
    );
    click(win, 'to-m');
    await settle();
    expect(win.document.querySelector('dialog')).not.toBeNull();
    await refresh();
    expect(calls).toEqual(['GET /m soft']);
    expect(win.document.querySelector('dialog')).not.toBeNull();
  });

  test('the router answers whether the refresh landed: a swap true, a skip false', async () => {
    const link = () => h('a', { id: 'to-m', href: '/m' }, 'm');
    const { win } = tab(
      { ...refreshed('A again', [link()]), '/m': () => htmlAnswer('modal:M2', modalOf('M')) },
      page('A', {}, [link()]),
    );
    expect(await currentRouter()?.refresh()).toBe(true);
    click(win, 'to-m');
    await settle();
    expect(await currentRouter()?.refresh()).toBe(false);
  });

  test('a refresh behind a click in flight answers false', async () => {
    let release = (_r: Response): void => undefined;
    const { win } = tab({
      ...refreshed('A again'),
      '/slow': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    click(win, 'to-slow');
    await settle();
    expect(await currentRouter()?.refresh()).toBe(false);
    release(htmlAnswer('page:Slow2', page('Slow')));
    await settle();
  });

  test('held when the answer arrives (the visitor started typing): nothing is swapped', async () => {
    let release = (_r: Response): void => undefined;
    let typing = false;
    const { doc } = tab(
      {
        '/a': () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      },
      withInput('A'),
    );
    const before = doc.getElementById('q');
    const ran = currentRouter()?.refresh(() => typing);
    await settle();
    typing = true;
    release(htmlAnswer('page:A-held', withInput('A again')));
    expect(await ran).toBe(false);
    await settle();
    expect(doc.getElementById('q')).toBe(before);
    expect(doc.title).toBe('A');
  });
});
