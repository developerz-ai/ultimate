// The instant modal: a click on a link to a route the document names a modal (`ultimate-modals`)
// opens the dialog in the same task — the frame, its close button, a busy body — and the route's
// document fills it when it arrives. Escape or Back while it loads aborts the fetch and leaves no
// entry; an answer that is no modal takes the frame down and is handled as before. The dialog is
// opened into the top layer WITHOUT `showModal()`, whose document-wide inertness recalculates the
// style of every element on the page (`navigation-modal-frame.ts`). Chrome: the e2e suite.
import { afterEach, describe, expect, test } from 'bun:test';
import { click, type Handler, page, stopRouter, tab } from './navigation-controller-fixture';
import {
  FakeDocument,
  type FakeElement,
  type FakeForm,
  type FakeWindow,
  h,
  htmlAnswer,
  routerHead,
  settle,
} from './navigation-dom-fixture';

afterEach(stopRouter);

const MODALS = JSON.stringify({
  routes: ['!/m/page', '/m', '/m/:id'],
  close: 'Close',
  loading: 'Loading',
});

const modalPage = (title: string) => {
  const form = h('form', { id: 'create', method: 'post' }) as FakeForm;
  return new FakeDocument(
    routerHead(title, [h('meta', { name: 'ultimate-presentation', content: 'modal' })]),
    [
      h('main', {}, [
        h('h1', {}, title),
        h('input', { id: 'first', autofocus: '' }),
        h('a', { id: 'deeper', href: '/m/2' }, 'deeper'),
        form,
      ]),
    ],
  );
};

/** `/a`, naming its modal routes, with links to a modal, a shadowing page and a plain page. */
const pageA = () =>
  new FakeDocument(routerHead('A', [h('meta', { name: 'ultimate-modals', content: MODALS })]), [
    h('main', {}, [
      h('h1', {}, 'A'),
      h('a', { id: 'to-m', href: '/m' }, 'm'),
      h('a', { id: 'to-m-page', href: '/m/page' }, 'shadowed'),
      h('a', { id: 'to-b', href: '/b' }, 'b'),
    ]),
  ]);

type Dialog = FakeElement & { open: boolean; popoverOpen: boolean; modalCalls: number };
const dialogOf = (win: FakeWindow) => win.document.querySelector('dialog') as Dialog | null;
const body = (win: FakeWindow) => dialogOf(win)?.querySelector('[data-x-modal-body]') ?? null;

/** A route whose answer the test releases, and the signal its request was sent with. */
function held(answer: () => Response) {
  let release: () => void = () => undefined;
  const sent: { signal?: AbortSignal | null } = {};
  const handler: Handler = (init) => {
    sent.signal = init?.signal ?? null;
    return new Promise<Response>((resolve) => {
      release = () => resolve(answer());
    });
  };
  return { handler, sent, release: () => release() };
}

const start = (routes: Record<string, Handler>) =>
  tab({ '/b': () => htmlAnswer('page:B', page('B')), ...routes }, pageA());

describe('the frame opens on the click', () => {
  test('before the answer: an open dialog, its close button, a busy body — no history yet', () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win, calls } = start({ '/m': slow.handler });
    click(win, 'to-m');
    // Same task as the click: nothing awaited.
    const dialog = dialogOf(win);
    expect(dialog?.open).toBe(true);
    expect(dialog?.hasAttribute('data-x-modal')).toBe(true);
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Loading');
    expect(body(win)?.getAttribute('aria-busy')).toBe('true');
    expect(body(win)?.querySelector('[data-x-modal-skeleton]')).not.toBeNull();
    const close = dialog?.querySelector('[data-x-modal-close]');
    expect(close?.getAttribute('aria-label')).toBe('Close');
    // A plain button, never a `<form>` a page's own `dialog form` selector would find first.
    expect(close?.getAttribute('type')).toBe('button');
    expect(dialog?.querySelector('form')).toBeNull();
    expect(calls).toEqual(['GET /m soft']);
    expect(win.location.href).toBe('https://app.test/a');
    expect(win.entries).toHaveLength(1);
  });

  test('the answer fills the same dialog: not busy, named by its heading, pushed, focus inside', async () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win, doc } = start({ '/m': slow.handler });
    click(win, 'to-m');
    const frame = dialogOf(win);
    slow.release();
    await settle();
    expect(dialogOf(win)).toBe(frame);
    expect(doc.querySelectorAll('dialog')).toHaveLength(1);
    expect(body(win)?.hasAttribute('aria-busy')).toBe(false);
    expect(body(win)?.querySelector('[data-x-modal-skeleton]')).toBeNull();
    expect(body(win)?.querySelector('h1')?.textContent).toBe('M');
    expect(frame?.hasAttribute('aria-label')).toBe(false);
    expect(doc.getElementById(frame?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('M');
    // The chrome stays: the close button is still there, after the content.
    expect(frame?.querySelector('[data-x-modal-close]')).not.toBeNull();
    expect(win.location.href).toBe('https://app.test/a#/m');
    expect(doc.activeElement?.id).toBe('first');
  });

  test('top layer without showModal: show() + showPopover(), never the inert document', () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win } = start({ '/m': slow.handler });
    click(win, 'to-m');
    const dialog = dialogOf(win);
    expect(dialog?.popoverOpen).toBe(true);
    expect(dialog?.getAttribute('popover')).toBe('manual');
    expect(dialog?.modalCalls).toBe(0);
  });

  test('a browser without popovers still gets a modal dialog: showModal()', () => {
    const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement
      .prototype as { showPopover?: unknown };
    const showPopover = proto.showPopover;
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win } = start({ '/m': slow.handler });
    delete proto.showPopover;
    try {
      click(win, 'to-m');
      expect(dialogOf(win)?.modalCalls).toBe(1);
      expect(dialogOf(win)?.hasAttribute('popover')).toBe(false);
    } finally {
      proto.showPopover = showPopover;
    }
  });

  test('a link the meta does not name a modal opens nothing until its answer says so', async () => {
    const { win } = start({});
    click(win, 'to-b');
    expect(dialogOf(win)).toBeNull();
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.document.querySelector('h1')?.textContent).toBe('B');
  });

  test('a more specific page the meta excludes (`!/m/page`) opens no frame', () => {
    const slow = held(() => htmlAnswer('page:MP', page('MP')));
    const { win } = start({ '/m/page': slow.handler });
    click(win, 'to-m-page');
    expect(dialogOf(win)).toBeNull();
  });

  test('a document without the meta behaves as before: no frame until the answer', () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const doc = new FakeDocument(routerHead('A'), [
      h('main', {}, [h('a', { id: 'to-m', href: '/m' }, 'm')]),
    ]);
    const { win } = tab({ '/m': slow.handler }, doc);
    click(win, 'to-m');
    expect(dialogOf(win)).toBeNull();
  });
});

describe('closing while it loads', () => {
  test('Escape aborts the fetch, removes the frame, leaves no entry; the late answer shows nothing', async () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win, doc } = start({ '/m': slow.handler });
    doc.getElementById('to-m')?.focus();
    click(win, 'to-m');
    dialogOf(win)?.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(slow.sent.signal?.aborted).toBe(true);
    expect(dialogOf(win)).toBeNull();
    slow.release();
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.entries).toHaveLength(1);
    expect(win.location.href).toBe('https://app.test/a');
    expect(doc.activeElement?.id).toBe('to-m');
  });

  test('the close button aborts it too', async () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win } = start({ '/m': slow.handler });
    click(win, 'to-m');
    dialogOf(win)?.querySelector('[data-x-modal-close]')?.dispatchEvent(new Event('click'));
    await settle();
    expect(slow.sent.signal?.aborted).toBe(true);
    expect(dialogOf(win)).toBeNull();
    expect(win.entries).toHaveLength(1);
  });

  test('a link elsewhere while it loads: that page, and the frame goes', async () => {
    const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
    const { win } = start({ '/m': slow.handler });
    click(win, 'to-m');
    click(win, 'to-b');
    await settle();
    slow.release();
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.document.querySelector('h1')?.textContent).toBe('B');
  });
});

describe('an answer that is no modal', () => {
  test('a page: the frame goes, the page swaps in as before', async () => {
    const { win } = start({ '/m': () => htmlAnswer('page:NotModal', page('Not modal')) });
    click(win, 'to-m');
    expect(dialogOf(win)).not.toBeNull();
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.document.querySelector('h1')?.textContent).toBe('Not modal');
    expect(win.location.href).toBe('https://app.test/m');
  });

  test('a network failure: the frame goes, the browser loads the URL (today’s error path)', async () => {
    const { win } = start({});
    click(win, 'to-m');
    expect(dialogOf(win)).not.toBeNull();
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.assigned).toEqual(['https://app.test/m']);
  });

  test('a stale address from code (`openModal`): the frame goes, the hash is dropped', async () => {
    const { win } = start({ '/m': () => htmlAnswer('nf', page('Missing'), { status: 404 }) });
    const router = (win as unknown as { __xNavigation: { openModal(p: string): Promise<void> } })
      .__xNavigation;
    const opening = router.openModal('/m');
    expect(dialogOf(win)).not.toBeNull();
    await opening;
    await settle();
    expect(dialogOf(win)).toBeNull();
    expect(win.location.href).toBe('https://app.test/a');
  });
});

describe('from inside an open modal', () => {
  test('a link to another modal keeps the dialog and its content, busy until the answer', async () => {
    const deeper = held(() => htmlAnswer('modal:Deeper', modalPage('Deeper')));
    const { win } = start({
      '/m': () => htmlAnswer('modal:M', modalPage('M')),
      '/m/2': deeper.handler,
    });
    click(win, 'to-m');
    await settle();
    const dialog = dialogOf(win);
    click(win, 'deeper');
    expect(dialogOf(win)).toBe(dialog);
    expect(body(win)?.getAttribute('aria-busy')).toBe('true');
    expect(body(win)?.querySelector('h1')?.textContent).toBe('M');
    deeper.release();
    await settle();
    expect(body(win)?.hasAttribute('aria-busy')).toBe(false);
    expect(body(win)?.querySelector('h1')?.textContent).toBe('Deeper');
    expect(win.location.href).toBe('https://app.test/a#/m/2');
  });
});

test('a browser close of the frame (`form method="dialog"`, closedby) aborts it as well', async () => {
  const slow = held(() => htmlAnswer('modal:M', modalPage('M')));
  const { win } = start({ '/m': slow.handler });
  click(win, 'to-m');
  dialogOf(win)?.close();
  await settle();
  expect(slow.sent.signal?.aborted).toBe(true);
  expect(dialogOf(win)).toBeNull();
});
