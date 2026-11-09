// What a confirmation, a shortcut table and its legend actually DO when wired — asked of the
// components and the page slot, not of the pure rules beside them (`confirm-dialog-view.test.ts`,
// `hotkeys-view.test.ts`). A separate file from `interaction.test.ts`, which is near its ceiling.
// The reactive half — a refusal re-rendering the summary and moving focus — is a browser's:
// `packages/cli/e2e/ui-confirm.e2e.test.ts`.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, one, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { FakeElement, type InstalledDom, installFakeDom } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { SolidContext, SolidRuntime } from '../theme/solid-adapter';
import { type HotkeyHost, hotkeyRowsOn, registerHotkeys } from '../use-hotkeys';
import { ConfirmDialog } from './ConfirmDialog';
import { ShortcutSheet } from './ShortcutSheet';

/** Every `onCleanup` the runtime was handed: a test's unmount. */
const cleanups: (() => void)[] = [];
const unmount = (): void => {
  for (const fn of cleanups.splice(0)) fn();
};

/** Signals that hold, effects that run at once: enough for a render to see what it registered. */
const syncRuntime: SolidRuntime = {
  createContext: <T>(defaultValue: T): SolidContext<T> => ({
    id: Symbol('test.context'),
    defaultValue,
    Provider: (props: { value: T; children?: unknown }) => props.children as never,
  }),
  useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
  createSignal: <T>(value: T) => {
    let current = value;
    return [
      (): T => current,
      (next: T): void => {
        current = next;
      },
    ] as [() => T, (next: T) => void];
  },
  createMemo: <T>(fn: () => T) => fn,
  createEffect: (fn: () => void): void => fn(),
  onCleanup: (fn: () => void): void => {
    cleanups.push(fn);
  },
  createRoot: <T>(fn: (dispose: () => void) => T): T => fn(() => {}),
};

const keyEvent = (key: string, extra: Record<string, unknown> = {}) => {
  const event = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target: null,
    timeStamp: 0,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
    ...extra,
  };
  return event;
};

/** A query string is a second instance of the module — what a second island's bundle is. */
const SECOND_CHUNK: string = '../use-hotkeys.ts?second-chunk';

/** The fake document as the slot sees it: its listener book takes any handler. */
const host = (dom: InstalledDom): HotkeyHost => dom.document as unknown as HotkeyHost;

const base = {
  title: 'Withdraw this post?',
  consequence: 'Readers lose the page at once.',
  confirmLabel: 'Withdraw post',
  trigger: 'Withdraw',
  id: 'withdraw',
};

afterEach(() => {
  unmount();
  clearSolidRuntime();
});

describe('ConfirmDialog, without script', () => {
  const nodes = renderNodes(ConfirmDialog, { ...base, action: '/api/posts/withdraw' });

  test('the trigger opens the dialog by invoker command, naming it by id', () => {
    const dialog = one(byTag(nodes, 'dialog'), '<dialog>');
    const trigger = one(withAttr(byTag(nodes, 'button'), 'command', 'show-modal'), 'trigger');
    expect(trigger.props['commandfor']).toBe(dialog.props['id']);
    expect(trigger.props['type']).toBe('button');
  });

  test('a real post form; Cancel is first, autofocused, and closes the dialog natively', () => {
    const form = one(byTag(nodes, 'form'), '<form>');
    expect(form.props['method']).toBe('post');
    expect(form.props['action']).toBe('/api/posts/withdraw');
    const submits = withAttr(byTag(nodes, 'button'), 'type', 'submit');
    expect(submits).toHaveLength(2);
    const [cancel, confirm] = submits;
    expect(cancel?.props['autofocus']).toBe(true);
    expect(cancel?.props['formmethod']).toBe('dialog');
    expect(cancel?.props['formnovalidate']).toBe(true);
    expect(confirm?.props['autofocus']).toBeUndefined();
    expect(confirm?.props['formmethod']).toBeUndefined();
  });

  test('nothing dismisses on a click: the dialog carries no click or pointer handler', () => {
    const dialog = one(byTag(nodes, 'dialog'), '<dialog>');
    expect(dialog.props['onClick']).toBeUndefined();
    expect(dialog.props['onPointerDown']).toBeUndefined();
  });
});

describe('ConfirmDialog, in an island', () => {
  const submitEvent = (submitter: FakeElement) => ({
    submitter,
    currentTarget: {},
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  });

  test('a double submit calls onConfirm once; done closes the dialog', async () => {
    setSolidRuntime(syncRuntime);
    let calls = 0;
    let settle: (value: string | undefined) => void = () => {};
    const nodes = renderNodes(ConfirmDialog, {
      ...base,
      onConfirm: () => {
        calls += 1;
        return new Promise<string | undefined>((resolve) => {
          settle = resolve;
        });
      },
    });
    let closed = 0;
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), { close: () => (closed += 1) });
    const form = one(byTag(nodes, 'form'), '<form>');
    const confirm = new FakeElement('button', { type: 'submit' });
    const first = submitEvent(confirm);
    fire(form, 'onSubmit', first);
    fire(form, 'onSubmit', submitEvent(confirm));
    expect(first.defaultPrevented).toBe(true);
    expect(calls).toBe(1);
    settle(undefined);
    await Promise.resolve();
    expect(closed).toBe(1);
  });

  test('a refusal leaves the dialog open, and Cancel is never treated as a confirm', async () => {
    setSolidRuntime(syncRuntime);
    let calls = 0;
    const nodes = renderNodes(ConfirmDialog, {
      ...base,
      onConfirm: () => {
        calls += 1;
        return Promise.resolve('Only the author can withdraw it');
      },
    });
    let closed = 0;
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), { close: () => (closed += 1) });
    const form = one(byTag(nodes, 'form'), '<form>');
    const cancel = submitEvent(new FakeElement('button', { formmethod: 'dialog' }));
    fire(form, 'onSubmit', cancel);
    expect(cancel.defaultPrevented).toBe(false);
    expect(calls).toBe(0);
    fire(form, 'onSubmit', submitEvent(new FakeElement('button', { type: 'submit' })));
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(closed).toBe(0);
  });

  test('an empty confirm label is refused before anything renders', () => {
    expect(() => renderNodes(ConfirmDialog, { ...base, confirmLabel: '', action: '/x' })).toThrow(
      'X_UI_INVALID_VALUE',
    );
  });
});

describe('the page hotkey slot', () => {
  test('two chunk copies of the module bind ONE keydown listener and share one table', async () => {
    const dom = installFakeDom(new FakeElement('div'));
    try {
      // A query string is a second module instance: what a second island chunk is.
      const copy = (await import(SECOND_CHUNK)) as typeof import('../use-hotkeys');
      expect(copy.registerHotkeys).not.toBe(registerHotkeys);
      const ran: string[] = [];
      registerHotkeys(host(dom), [{ keys: ['g f'], label: 'Feed', run: () => ran.push('f') }]);
      copy.registerHotkeys(host(dom), [{ keys: ['?'], label: 'Help', run: () => ran.push('?') }]);
      expect(dom.document.listeners.get('keydown')?.size).toBe(1);
      expect(copy.hotkeyRowsOn(host(dom)).rows.map((row) => row.label)).toEqual(['Feed', 'Help']);
      dom.document.dispatch('keydown', keyEvent('?'));
      expect(ran).toEqual(['?']);
      // The second copy's table refuses a binding the first copy's already holds.
      expect(() =>
        copy.registerHotkeys(host(dom), [{ keys: ['?'], label: 'Again', run: () => {} }]),
      ).toThrow('X_UI_INVALID_VALUE');
      expect(hotkeyRowsOn(host(dom)).rows).toHaveLength(2);
    } finally {
      dom.restore();
    }
  });

  test('a bare key typed into a field is text; mod+k there still fires', () => {
    const dom = installFakeDom(new FakeElement('div'));
    try {
      const ran: string[] = [];
      registerHotkeys(
        host(dom),
        [
          { keys: ['?'], label: 'Help', run: () => ran.push('?') },
          { keys: ['mod+k'], label: 'Palette', run: () => ran.push('k') },
        ],
        false,
      );
      const field = { closest: (selector: string) => (selector.includes('input') ? {} : null) };
      const typed = keyEvent('?', { target: field });
      dom.document.dispatch('keydown', typed);
      expect(typed.prevented).toBe(false);
      const palette = keyEvent('k', { target: field, ctrlKey: true });
      dom.document.dispatch('keydown', palette);
      expect(palette.prevented).toBe(true);
      expect(ran).toEqual(['k']);
    } finally {
      dom.restore();
    }
  });
});

describe('ShortcutSheet reads the same table', () => {
  test('it lists mod+k and its own ?, and a removed row leaves the binding and the line', () => {
    setSolidRuntime(syncRuntime);
    const dom = installFakeDom(new FakeElement('div'));
    try {
      const ran: string[] = [];
      const remove = registerHotkeys(
        host(dom),
        [{ keys: ['mod+k'], label: 'Command palette', run: () => ran.push('k') }],
        false,
      );
      const nodes = renderNodes(ShortcutSheet, { title: 'Keyboard shortcuts' });
      expect(byTag(nodes, 'dt').map((node) => node.props['children'])).toEqual([
        'Command palette',
        'Keyboard shortcuts',
      ]);
      expect(byTag(nodes, 'kbd').map((node) => node.props['children'])).toEqual(['Ctrl', 'K', '?']);

      remove();
      unmount();
      dom.document.dispatch('keydown', keyEvent('k', { ctrlKey: true }));
      expect(ran).toEqual([]);
      const after = renderNodes(ShortcutSheet, { title: 'Keyboard shortcuts' });
      expect(byTag(after, 'dt').map((node) => node.props['children'])).not.toContain(
        'Command palette',
      );
    } finally {
      dom.restore();
    }
  });
});
