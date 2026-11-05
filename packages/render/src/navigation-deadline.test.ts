// A navigation whose answer never arrives is given up at `NAVIGATION_TIMEOUT_MS`: its request is
// aborted, it fails the way a network failure does (a GET is the browser's, a POST is reported),
// and the router is free again — a hung refresh used to make every later refresh yield to it.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  click,
  currentRouter,
  type Handler,
  page,
  stopRouter,
  tab,
} from './navigation-controller-fixture';
import { NAVIGATION_TIMEOUT_MS } from './navigation-deadline';
import { htmlAnswer, settle } from './navigation-dom-fixture';
import { NAVIGATION_ERROR_EVENT } from './navigation-rules';

afterEach(stopRouter);

/** A fetch that never answers, recording the signal it was handed. */
const hung = (signals: (AbortSignal | undefined)[]): Handler => {
  return (init) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>(() => {});
  };
};

/** Deadline timers are held for the test to fire; every other timer runs as it would. */
function heldDeadlines(win: { setTimeout(fn: () => void, ms?: number): number }) {
  const due: (() => void)[] = [];
  const real = win.setTimeout.bind(win);
  win.setTimeout = (fn: () => void, ms?: number): number => {
    if (ms !== NAVIGATION_TIMEOUT_MS) return real(fn, ms);
    due.push(fn);
    return -1;
  };
  return {
    pending: (): number => due.length,
    expire: (): void => {
      for (const fn of due.splice(0)) fn();
    },
  };
}

describe('the navigation deadline', () => {
  test('a GET that never answers is aborted at the deadline and loaded by the browser', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { win } = tab({ '/slow': hung(signals) });
    const deadline = heldDeadlines(win);
    click(win, 'to-slow');
    await settle();
    expect(win.assigned).toEqual([]);
    expect(deadline.pending()).toBe(1);
    deadline.expire();
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(win.assigned).toEqual(['https://app.test/slow']);
  });

  test('a hung PREFETCH the click reuses is bounded too, though it was fetched with no signal', async () => {
    const { win, calls } = tab({ '/slow': hung([]) });
    const deadline = heldDeadlines(win);
    currentRouter()?.prefetch('https://app.test/slow');
    click(win, 'to-slow');
    await settle();
    expect(calls).toHaveLength(1);
    deadline.expire();
    await settle();
    expect(win.assigned).toEqual(['https://app.test/slow']);
  });

  test('a POST that never answers is reported as a failed navigation, never dropped', async () => {
    const { win, doc } = tab({ '/b': hung([]) });
    const deadline = heldDeadlines(win);
    const reasons: unknown[] = [];
    doc.addEventListener(NAVIGATION_ERROR_EVENT, (event) => {
      reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
      event.preventDefault();
    });
    void currentRouter()?.navigate('https://app.test/b', { method: 'POST', body: new FormData() });
    await settle();
    deadline.expire();
    await settle();
    expect(reasons).toHaveLength(1);
  });

  test('a refresh that never answers fails quietly and frees the router: the next one fetches', async () => {
    let asked = 0;
    const { win, calls } = tab({
      '/a': (init) => {
        asked += 1;
        return asked === 1 ? hung([])(init) : htmlAnswer('page:A2', page('A2'));
      },
    });
    const deadline = heldDeadlines(win);
    const first = currentRouter()?.refresh();
    await settle();
    deadline.expire();
    await settle();
    // Quietly: never a reload under the reader, and settled, so the scheduler does not owe it.
    expect(win.assigned).toEqual([]);
    expect(await first).toBe(true);
    await currentRouter()?.refresh();
    await settle();
    expect(calls.filter((call) => call.startsWith('GET /a'))).toHaveLength(2);
  });

  test('an answer in time clears its deadline', async () => {
    const { win, doc } = tab({ '/b': () => htmlAnswer('page:B', page('B')) });
    const cleared: number[] = [];
    const real = win.clearTimeout.bind(win);
    win.clearTimeout = (id: number | undefined): void => {
      if (id !== undefined) cleared.push(id);
      real(id);
    };
    const deadline = heldDeadlines(win);
    click(win, 'to-b');
    await settle();
    expect(doc.title).toBe('B');
    expect(deadline.pending()).toBe(1);
    expect(cleared).toContain(-1);
  });
});
