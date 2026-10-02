// The prefetch cache against a write, interleaved by hand: a guess still IN FLIGHT when the write
// is announced never answers the click after it, a guess sent AFTER the write does, and a guess
// sent while the router's own POST was in flight is forgotten when that POST settles.
import { afterEach, describe, expect, test } from 'bun:test';
import { notifyClientWrite, rescope } from '@ultimat3/core/page';
import {
  answers,
  click,
  currentRouter,
  fire,
  page,
  stopRouter,
  tab,
} from './navigation-controller-fixture';
import { type FakeForm, h, htmlAnswer, settle } from './navigation-dom-fixture';

afterEach(stopRouter);

const B = 'https://app.test/b';

/** `/b` answered by hand: each request waits for its own `release`, in the order they were sent. */
const heldRoute = () => {
  const releases: ((response: Response) => void)[] = [];
  const handler = () =>
    new Promise<Response>((resolve) => {
      releases.push(resolve);
    });
  return { handler, releases };
};

const stale = () => htmlAnswer('page:Stale', page('Stale'));

describe('a guess in flight when the cache is emptied', () => {
  const emptiers: [string, () => void][] = [
    ['a client write', () => notifyClientWrite('/api/x')],
    ['a rescope', () => rescope('member:7')],
    ['another tab', () => new BroadcastChannel('ultimate:navigation').postMessage('clear')],
  ];
  for (const [name, empty] of emptiers) {
    test(`${name}: the answer that lands afterwards never answers the click`, async () => {
      const { handler, releases } = heldRoute();
      const { win, doc, calls } = tab({ '/b': handler });
      currentRouter()?.prefetch(B);
      expect(calls).toEqual(['GET /b prefetch']);
      empty();
      // Another tab's message is delivered as a task, never inside `postMessage`.
      await settle(20);
      releases[0]?.(stale());
      await settle();
      click(win, 'to-b');
      expect(calls).toEqual(['GET /b prefetch', 'GET /b soft']);
      releases[1]?.(answers.b());
      await settle();
      expect(doc.title).toBe('B');
    });
  }

  test('a guess sent AFTER the write is fresh: it answers the click, and nothing is asked twice', async () => {
    const { win, doc, calls } = tab({ '/b': answers.b });
    notifyClientWrite('/api/x');
    currentRouter()?.prefetch(B);
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual(['GET /b prefetch']);
    expect(doc.title).toBe('B');
  });
});

describe("the router's own POST", () => {
  const form = (): FakeForm => {
    const f = h('form', { id: 'f', method: 'post', action: '/send' }) as FakeForm;
    f.fields = [['name', 'ada']];
    return f;
  };

  test('a guess sent while the POST was in flight is forgotten when it settles', async () => {
    const send = heldRoute();
    let rendered = 0;
    const { win, doc, calls } = tab(
      {
        '/send': send.handler,
        // The first render is the guess, made before the write committed.
        '/b': () => {
          rendered += 1;
          return rendered === 1 ? stale() : answers.b();
        },
        '/done': () => htmlAnswer('page:Done', page('Done')),
      },
      page('A', {}, [form()]),
    );
    fire(win, 'submit', doc.getElementById('f'), { submitter: null });
    currentRouter()?.prefetch(B);
    await settle();
    expect(calls).toEqual(['POST /send soft', 'GET /b prefetch']);
    send.releases[0]?.(
      new Response(null, { status: 204, headers: { 'x-ultimate-location': '/done' } }),
    );
    await settle();
    expect(doc.title).toBe('Done');
    click(win, 'to-b');
    await settle();
    expect(calls.slice(2)).toEqual(['GET /done soft', 'GET /b soft']);
    expect(doc.title).toBe('B');
  });

  test('a POST that fails on the network may still have landed: the guess is forgotten too', async () => {
    let fail = (_reason: unknown): void => undefined;
    const { win, doc, calls } = tab(
      {
        '/send': () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
        '/b': answers.b,
      },
      page('A', {}, [form()]),
    );
    doc.addEventListener('ultimate:navigation-error', (event) => event.preventDefault());
    fire(win, 'submit', doc.getElementById('f'), { submitter: null });
    currentRouter()?.prefetch(B);
    await settle();
    fail(new TypeError('network'));
    await settle();
    click(win, 'to-b');
    await settle();
    expect(calls).toEqual(['POST /send soft', 'GET /b prefetch', 'GET /b soft']);
  });
});
