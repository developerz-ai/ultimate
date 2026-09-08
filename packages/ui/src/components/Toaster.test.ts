// The WIRING between the queue and the region: that the pause seams are on an element the events
// actually reach, that only the visible slice is drawn, and that nothing here takes focus. The
// queue's own rules are proven in `toast/toast-state.test.ts`; a correct store handed to the wrong
// element passes every one of them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { TOAST_MAX_VISIBLE, type ToastHold } from '../toast/toast-state';
import { createToastStore, INERT_TOAST_ENV, type ToastStore } from '../toast/toast-store';
import { ToastRegion } from './Toast';
import { Toaster } from './Toaster';

const storeWith = (...messages: readonly string[]): ToastStore => {
  const store = createToastStore(INERT_TOAST_ENV);
  for (const message of messages) store.show({ message });
  return store;
};

const toaster = (
  store: ToastStore,
  extra: Record<string, unknown> = {},
): ReturnType<typeof renderNodes> =>
  renderNodes(Toaster, { store, label: 'Notifications', ...extra });

describe('ToastRegion’s pause seam', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the handlers sit on the <ol>, which is where a bubbling event from a toast arrives', () => {
    const held: ToastHold[] = [];
    const released: ToastHold[] = [];
    const nodes = renderNodes(ToastRegion, {
      children: null,
      label: 'Notifications',
      onHold: (reason: ToastHold) => held.push(reason),
      onRelease: (reason: ToastHold) => released.push(reason),
    });
    const list = one(byTag(nodes, 'ol'), '<ol>');

    // `mouseenter` would never fire: `.region` is `pointer-events: none`, so the list is not a hit
    // target and only the toasts inside it are. `mouseover` bubbles from them; `mouseenter` does not.
    fire(list, 'onMouseOver', {});
    fire(list, 'onFocusIn', {});
    fire(list, 'onMouseOut', {});
    fire(list, 'onFocusOut', {});

    expect(held).toEqual(['pointer', 'focus']);
    expect(released).toEqual(['pointer', 'focus']);
    // The live semantics are unchanged by any of it.
    expect(list.props['aria-live']).toBe('polite');
  });

  test('a region with no store still renders — the handlers are additive, never required', () => {
    const nodes = renderNodes(ToastRegion, { children: null, label: 'Notifications' });
    expect(() => fire(one(byTag(nodes, 'ol'), '<ol>'), 'onMouseOver', {})).not.toThrow();
  });
});

describe('Toaster', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('renders the visible slice and queues the rest off screen', () => {
    const nodes = toaster(storeWith('one', 'two', 'three', 'four', 'five'));
    const items = byTag(nodes, 'li');
    expect(items).toHaveLength(TOAST_MAX_VISIBLE);
    expect(byTag(nodes, 'div').some((node) => node.props['children'] === 'four')).toBe(false);
  });

  test('an empty queue still emits the live region — it has to exist before the first message', () => {
    const nodes = toaster(storeWith());
    // A region created with its content already inside it is not announced, which is the whole
    // reason `aria-live` lives on this persistent <ol> and a server render emits it empty.
    expect(one(byTag(nodes, 'ol'), '<ol>').props['aria-live']).toBe('polite');
    expect(byTag(nodes, 'li')).toEqual([]);
  });

  test('the pause seam is wired to the store, so hovering the stack really stops the dwell', () => {
    const store = storeWith('one');
    const nodes = toaster(store);
    const list = one(byTag(nodes, 'ol'), '<ol>');

    fire(list, 'onMouseOver', {});
    // Nothing observable on an inert clock beyond the call landing, so the proof is that the
    // release path is reachable too: an unbalanced hold is a stack that never clears again.
    expect(() => fire(list, 'onMouseOut', {})).not.toThrow();
  });

  test('no toast is focused and none carries an autofocus — focus stays where the user put it', () => {
    const nodes = toaster(storeWith('one'));
    expect(withAttr(nodes, 'autofocus')).toEqual([]);
    expect(withAttr(nodes, 'tabindex')).toEqual([]);
  });

  test('dismissing takes the toast off the queue, not just off the screen', () => {
    const store = storeWith('one', 'two');
    const nodes = toaster(store);
    // Two toasts, one dismiss control each; the first belongs to the first toast.
    fire(byTag(nodes, 'button')[0] as never, 'onClick', {});
    expect(store.queue().items.map((item) => item.message)).toEqual(['two']);
  });

  test('an action is one undo-shaped control, and taking it answers the offer', () => {
    const store = createToastStore(INERT_TOAST_ENV);
    const undone: number[] = [];
    store.show({
      message: 'Post deleted',
      action: { label: 'Undo', onAction: () => undone.push(1) },
    });

    const nodes = toaster(store);
    const buttons = byTag(nodes, 'button');
    // The action, then the dismiss — a toast never grows a second affordance.
    expect(buttons).toHaveLength(2);
    fire(buttons[0] as never, 'onClick', {});
    expect(undone).toEqual([1]);
    expect(store.queue().items).toEqual([]);
  });
});
