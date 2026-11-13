// The sheet's snap across a close and a reopen, under a real Solid runtime: `snap` is the height
// a sheet OPENS at, so a drag to `full` last time must not decide where it opens next time. The
// drag itself is proven in `navigation-interaction.test.ts`; the release rule in its view file.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, nodesOf, one, withAttr } from '@ultimat3/core/render-nodes';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Drawer } from './Drawer';
import type { DrawerSnap } from './drawer-gesture-view';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

/** The `<dialog>` surface the drawer touches: modal state, and the drag's height and offset. */
const fakeDialog = () => {
  const style = new Map<string, string>();
  const dialog = {
    open: false,
    style: {
      setProperty: (name: string, value: string) => void style.set(name, value),
      removeProperty: (name: string) => void style.delete(name),
    },
    drag: (): string | undefined => style.get('--drawer-drag'),
    showModal: () => {
      dialog.open = true;
    },
    close: () => {
      dialog.open = false;
    },
    getBoundingClientRect: () => ({ height: 400 }),
    setAttribute: () => {},
    removeAttribute: () => {},
  };
  return dialog;
};

const pointer = (clientY: number) => ({
  pointerId: 1,
  clientY,
  currentTarget: { setPointerCapture: () => {} },
});

describe('Drawer sheet snap, under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  const mount = (snap?: DrawerSnap) => {
    const { createContext, useContext, createSignal, createMemo, createEffect, onCleanup } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot: solid.createRoot,
    });
    const [open, setOpen] = solid.createSignal(true);
    const dialog = fakeDialog();
    let output: unknown;
    let dispose = (): void => {};
    solid.createRoot((done) => {
      dispose = done;
      output = Drawer({
        get open() {
          return open();
        },
        title: 'Comments',
        side: 'block-end',
        grabber: true,
        snap,
        onClose: () => setOpen(false),
        children: 'body',
      });
      // The ref Solid would hand out during render — attached before the open effect runs.
      attachRef(one(byTag(nodesOf(output), 'dialog'), '<dialog>'), dialog);
    });
    const grabber = () =>
      one(
        withAttr(nodesOf(output), 'aria-hidden', 'true').filter(
          (n) => n.props['onPointerDown'] !== undefined,
        ),
        'grabber',
      );
    /**
     * The snap the sheet is at, read through the one place it is observable without a DOM: an
     * upward drag follows at a third from `half` and not at all from `full` (`dragOffset`).
     */
    const at = (): DrawerSnap => {
      fire(grabber(), 'onPointerDown', pointer(400));
      fire(grabber(), 'onPointerMove', pointer(100));
      const offset = dialog.drag();
      fire(grabber(), 'onPointerCancel', pointer(100));
      return offset === '0px' ? 'full' : 'half';
    };
    return { at, grabber, dialog, setOpen, dispose: () => dispose() };
  };

  test('dragged to full, closed and reopened, it opens at the prop’s height again', () => {
    const view = mount();
    expect(view.dialog.open).toBe(true);
    expect(view.at()).toBe('half');
    fire(view.grabber(), 'onPointerDown', pointer(300));
    fire(view.grabber(), 'onPointerUp', pointer(100));
    expect(view.at()).toBe('full');

    view.setOpen(false);
    expect(view.dialog.open).toBe(false);
    view.setOpen(true);
    expect(view.dialog.open).toBe(true);
    expect(view.at()).toBe('half');
    view.dispose();
  });

  test('snap="full", settled to half by a drag, reopens at full', () => {
    const view = mount('full');
    expect(view.at()).toBe('full');
    fire(view.grabber(), 'onPointerDown', pointer(100));
    fire(view.grabber(), 'onPointerUp', pointer(200));
    expect(view.at()).toBe('half');
    view.setOpen(false);
    view.setOpen(true);
    expect(view.at()).toBe('full');
    view.dispose();
  });
});
