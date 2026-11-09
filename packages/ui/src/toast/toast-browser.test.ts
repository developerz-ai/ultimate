// The toast store's browser half: the env it builds over the real timer, `document.hidden` and the
// `visibilitychange` event; the store picking that env exactly when a DOM is there and releasing
// its listener on `stop()`; and `useToasts` keeping its signal on the store until unmount.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { installGlobals, syncRuntime } from '../browser-fake-fixture';
import { FakeDocument } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { browserToastEnv, INERT_TOAST_ENV, toastStore } from './toast-store';
import { useToasts } from './use-toasts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  clearSolidRuntime();
  jest.useRealTimers();
});

const hiddenDocument = (hidden: boolean) => {
  const doc = Object.assign(new FakeDocument(), { hidden });
  restore = installGlobals({ document: doc });
  return doc;
};

const listening = (doc: FakeDocument): number => doc.listeners.get('visibilitychange')?.size ?? 0;

describe('browserToastEnv', () => {
  test('the timer is the platform’s, cancellable; the clock is Date.now', () => {
    jest.useFakeTimers();
    const env = browserToastEnv();
    const fired: string[] = [];
    env.setTimer(() => fired.push('kept'), 100);
    const dropped = env.setTimer(() => fired.push('dropped'), 50);
    env.clearTimer(dropped);
    jest.advanceTimersByTime(99);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['kept']);
    expect(env.now()).toBe(Date.now());
  });

  test('hidden is document.hidden; the visibility subscription adds and removes one listener', () => {
    const doc = hiddenDocument(true);
    const env = browserToastEnv();
    expect(env.isHidden()).toBe(true);
    doc.hidden = false;
    expect(env.isHidden()).toBe(false);
    let heard = 0;
    const stop = env.onVisibilityChange(() => (heard += 1));
    doc.dispatch('visibilitychange', {});
    expect(heard).toBe(1);
    stop();
    expect(listening(doc)).toBe(0);
    doc.dispatch('visibilitychange', {});
    expect(heard).toBe(1);
  });
});

describe('toastStore with no env given', () => {
  test('in a DOM it listens for visibility, and stop() lets go', () => {
    const doc = hiddenDocument(false);
    const store = toastStore();
    expect(listening(doc)).toBe(1);
    store.stop();
    expect(listening(doc)).toBe(0);
  });

  test('with no DOM it is the inert store: nothing to listen to, still a working queue', () => {
    const store = toastStore();
    store.show({ message: 'Saved' });
    expect(store.queue().items.map((item) => item.message)).toEqual(['Saved']);
  });
});

describe('useToasts', () => {
  test('the signal follows the store from the effect on, and stops at unmount', () => {
    const rt = syncRuntime();
    setSolidRuntime(rt.runtime);
    const store = toastStore(INERT_TOAST_ENV);
    store.show({ message: 'first' });
    const queue = useToasts(store);
    expect(queue().items.map((item) => item.message)).toEqual(['first']);
    store.show({ message: 'second' });
    expect(queue().items.map((item) => item.message)).toEqual(['first', 'second']);
    rt.unmount();
    store.show({ message: 'third' });
    expect(queue().items).toHaveLength(2);
  });
});
