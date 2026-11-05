// `scheduleRefresh()` over an injected window, clock and timers: owed while hidden, held under an
// open dialog, a focused field, a selection and fresh input, one trailing run for any number of
// asks, nothing after a lost session, and one state per page however many chunks carry the module.
import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core/page';
import { type IdleWindow, QUIET_MS, refreshIdleOn } from './refresh-idle';

const KEY = Symbol.for('ultimate.refresh-idle');

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

interface FakeEl {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
}

/** A tab: a router whose refresh the test settles, a document's state, timers run by hand. */
function fakeTab(withRouter = true) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const handlers = new Map<string, Set<() => void>>();
  const settles: ((ran: boolean) => void)[] = [];
  const heldSeen: ((() => boolean) | undefined)[] = [];
  const state = {
    hidden: false,
    dialog: false,
    navigating: false,
    active: null as FakeEl | null,
    selection: true,
  };
  let refreshes = 0;
  const on = (type: string, fn: () => void): void => {
    const set = handlers.get(type) ?? new Set();
    set.add(fn);
    handlers.set(type, set);
  };
  const body: FakeEl = { tagName: 'BODY' };
  const win = {
    __xNavigation: withRouter
      ? {
          refresh: (held?: () => boolean): Promise<boolean> => {
            refreshes += 1;
            heldSeen.push(held);
            return new Promise<boolean>((resolve) => settles.push(resolve));
          },
        }
      : undefined,
    document: {
      get visibilityState(): string {
        return state.hidden ? 'hidden' : 'visible';
      },
      get activeElement(): FakeEl | null {
        return state.active ?? body;
      },
      body,
      documentElement: {
        hasAttribute: (name: string): boolean => name === 'data-x-navigating' && state.navigating,
      },
      querySelector: (selector: string): object | null =>
        selector.includes('dialog[open]') && state.dialog ? {} : null,
      addEventListener: on,
    },
    addEventListener: on,
    getSelection: () => ({ isCollapsed: state.selection }),
    setTimeout: (fn: () => void, ms: number): number => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id: number | undefined): void => {
      if (id !== undefined) timers.delete(id);
    },
  } as unknown as IdleWindow;
  const clock = { monotonic: (): number => now, now: (): Date => new Date(now) };
  return {
    win,
    clock,
    state,
    refreshes: (): number => refreshes,
    heldSeen,
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    emit(type: string): void {
      for (const fn of handlers.get(type) ?? []) fn();
    },
    async settle(ran = true): Promise<void> {
      settles.shift()?.(ran);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('scheduleRefresh', () => {
  test('runs at once on a quiet page, and many asks while running owe ONE trailing run', async () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    schedule();
    expect(tab.refreshes()).toBe(1);
    schedule();
    schedule();
    schedule();
    expect(tab.refreshes()).toBe(1);
    await tab.settle();
    expect(tab.refreshes()).toBe(2);
    await tab.settle();
    expect(tab.refreshes()).toBe(2);
  });

  test('a hidden tab owes it, and pays once when shown', () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    tab.state.hidden = true;
    schedule();
    schedule();
    tab.advance(10_000);
    expect(tab.refreshes()).toBe(0);
    tab.state.hidden = false;
    tab.emit('visibilitychange');
    expect(tab.refreshes()).toBe(1);
  });

  test('held while a dialog is open, paid when it closes', () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    tab.state.dialog = true;
    schedule();
    tab.advance(QUIET_MS * 3);
    expect(tab.refreshes()).toBe(0);
    tab.state.dialog = false;
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(1);
  });

  test('held while focus is in a field, a selection is open or a navigation runs', () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    tab.state.active = { tagName: 'TEXTAREA' };
    schedule();
    tab.advance(QUIET_MS);
    tab.state.active = { tagName: 'DIV', isContentEditable: true };
    tab.advance(QUIET_MS);
    tab.state.active = null;
    tab.state.selection = false;
    tab.advance(QUIET_MS);
    tab.state.selection = true;
    tab.state.navigating = true;
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(0);
    tab.state.navigating = false;
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(1);
  });

  test('held for QUIET_MS after a scroll, a key or a wheel', () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    tab.emit('scroll');
    schedule();
    tab.advance(QUIET_MS - 1);
    expect(tab.refreshes()).toBe(0);
    tab.advance(1);
    expect(tab.refreshes()).toBe(1);
  });

  test('a press holds until released, and stops holding after 10 s unreleased', async () => {
    const tab = fakeTab();
    const schedule = refreshIdleOn(tab.win, tab.clock);
    tab.emit('pointerdown');
    schedule();
    tab.advance(5_000);
    expect(tab.refreshes()).toBe(0);
    tab.emit('pointerup');
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(1);
    await tab.settle();
    tab.emit('pointerdown');
    schedule();
    tab.advance(10_000);
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(2);
  });

  test('after a lost session: nothing, ever', async () => {
    rescope('user:1');
    const { clientTransport } = await import('@ultimat3/core/page');
    await clientTransport({
      method: 'GET',
      url: '/q/x',
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'X_UNAUTHENTICATED', cause: 'c', fix: 'f' }), {
          status: 401,
        }),
    }).catch(() => undefined);
    const tab = fakeTab();
    refreshIdleOn(tab.win, tab.clock)();
    tab.advance(QUIET_MS * 5);
    expect(tab.refreshes()).toBe(0);
  });

  test('no router: nothing, rather than reload a page under a reader', () => {
    const tab = fakeTab(false);
    refreshIdleOn(tab.win, tab.clock)();
    tab.advance(QUIET_MS * 5);
    expect(Reflect.get(tab.win, KEY)).toBeUndefined();
  });

  test('two chunk copies of the module share one state per page', async () => {
    // A query string is a second module instance: what a second island chunk carries.
    const specifier = './refresh-idle.ts?copy';
    const copy = (await import(specifier)) as typeof import('./refresh-idle');
    expect(copy.refreshIdleOn).not.toBe(refreshIdleOn);
    const tab = fakeTab();
    refreshIdleOn(tab.win, tab.clock)();
    copy.refreshIdleOn(tab.win, tab.clock)();
    expect(tab.refreshes()).toBe(1);
    await tab.settle();
    expect(tab.refreshes()).toBe(2);
  });

  test('a refresh the router skipped is owed again, and paid QUIET_MS later', async () => {
    const tab = fakeTab();
    refreshIdleOn(tab.win, tab.clock)();
    expect(tab.refreshes()).toBe(1);
    await tab.settle(false);
    expect(tab.refreshes()).toBe(1);
    tab.advance(QUIET_MS);
    expect(tab.refreshes()).toBe(2);
    await tab.settle(true);
    tab.advance(QUIET_MS * 3);
    expect(tab.refreshes()).toBe(2);
  });

  test('the router is handed the hold, so a visitor busy by the time the answer lands is not swapped under', () => {
    const tab = fakeTab();
    refreshIdleOn(tab.win, tab.clock)();
    const held = tab.heldSeen[0];
    expect(held?.()).toBe(false);
    tab.state.dialog = true;
    expect(held?.()).toBe(true);
    tab.state.dialog = false;
    tab.emit('keydown');
    expect(held?.()).toBe(true);
  });
});
