// The rest of ConfirmDialog's island half: the trigger opens the dialog itself only where the
// engine has no invoker commands, a rejected act reads as a refusal and keeps the dialog open,
// closing it clears the refusal (but never mid-flight), and the server's error shows on open.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  attachRef,
  byComponent,
  byTag,
  fire,
  one,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { installGlobals, syncRuntime } from '../browser-fake-fixture';
import { FakeElement } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmState } from './confirm-dialog-view';

const base = {
  title: 'Withdraw this post?',
  consequence: 'Readers lose the page at once.',
  confirmLabel: 'Withdraw post',
  trigger: 'Withdraw',
  id: 'withdraw',
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  clearSolidRuntime();
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

const submit = () => ({
  submitter: new FakeElement('button', { type: 'submit' }),
  currentTarget: {},
  preventDefault: () => {},
});

const mount = (onConfirm: () => Promise<string | undefined>) => {
  const rt = syncRuntime();
  setSolidRuntime(rt.runtime);
  const nodes = renderNodes(ConfirmDialog, { ...base, onConfirm });
  // ConfirmDialog's one signal: the confirmation state.
  const state = rt.signals[0] as () => ConfirmState;
  let closed = 0;
  const dialogNode = one(byTag(nodes, 'dialog'), '<dialog>');
  attachRef(dialogNode, { close: () => (closed += 1) });
  return { nodes, state, dialogNode, closed: () => closed };
};

describe('the trigger', () => {
  const trigger = (nodes: ReturnType<typeof renderNodes>) =>
    one(withAttr(byTag(nodes, 'button'), 'command', 'show-modal'), 'trigger');
  const dialog = (open: boolean) => {
    const opened: string[] = [];
    return { open, showModal: () => opened.push('showModal'), opened };
  };

  test('with no invoker commands, a click opens a closed dialog — and never an open one', () => {
    const nodes = renderNodes(ConfirmDialog, { ...base, action: '/x' });
    const closed = dialog(false);
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), closed);
    fire(trigger(nodes), 'onClick', {});
    expect(closed.opened).toEqual(['showModal']);
    const nodes2 = renderNodes(ConfirmDialog, { ...base, action: '/x' });
    const open = dialog(true);
    attachRef(one(byTag(nodes2, 'dialog'), '<dialog>'), open);
    fire(trigger(nodes2), 'onClick', {});
    expect(open.opened).toEqual([]);
  });

  test('where the engine runs invoker commands itself, the click does nothing', () => {
    class Button {}
    Object.defineProperty(Button.prototype, 'commandForElement', { value: null });
    restore = installGlobals({ HTMLButtonElement: Button });
    const nodes = renderNodes(ConfirmDialog, { ...base, action: '/x' });
    const closed = dialog(false);
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), closed);
    fire(trigger(nodes), 'onClick', {});
    expect(closed.opened).toEqual([]);
  });

  test('before the dialog ref lands, a click is a no-op rather than a throw', () => {
    const nodes = renderNodes(ConfirmDialog, { ...base, action: '/x' });
    fire(trigger(nodes), 'onClick', {});
    expect(byTag(nodes, 'dialog')).toHaveLength(1);
  });
});

describe('a rejected act and a close', () => {
  test('a rejection is a refusal in the page language, and the dialog stays open', async () => {
    const view = mount(() => Promise.reject(new Error('network')));
    fire(one(byTag(view.nodes, 'form'), '<form>'), 'onSubmit', submit());
    expect(view.state().kind).toBe('busy');
    await settle();
    const state = view.state();
    expect(state.kind).toBe('refused');
    expect(state.kind === 'refused' ? state.message : '').toBe('⟦ui.error.title⟧');
    expect(view.closed()).toBe(0);
  });

  test('closing clears a refusal; a close while the act is in flight changes nothing', async () => {
    let answer: (refusal: string | undefined) => void = () => {};
    const view = mount(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    fire(one(byTag(view.nodes, 'form'), '<form>'), 'onSubmit', submit());
    fire(view.dialogNode, 'onClose', {});
    expect(view.state().kind).toBe('busy');
    answer('Locked');
    await settle();
    expect(view.state()).toEqual({ kind: 'refused', message: 'Locked' });
    fire(view.dialogNode, 'onClose', {});
    expect(view.state().kind).toBe('idle');
  });

  test('the server’s refusal is the form’s error on open', () => {
    const nodes = renderNodes(
      ConfirmDialog,
      { ...base, action: '/x', error: 'Already withdrawn' },
      { components: 'keep' },
    );
    expect(one(byComponent(nodes, 'Form'), '<Form>').props['error']).toBe('Already withdrawn');
  });
});
