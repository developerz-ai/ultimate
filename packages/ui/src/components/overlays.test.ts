// The four overlays do their real work in an effect, and an effect never runs on the inert server
// path — so `showModal()`, the outside-click dismissal, Escape, and the focus trap were all
// unexercised. This file registers a runtime that queues effects and runs them after the tree
// exists (Solid's order), attaches a `fake-dom` element to each `ref`, and then asks what the
// component actually did.

import { afterEach, describe, expect, test } from 'bun:test';
import { FakeElement, type InstalledDom, installFakeDom, keydown } from '../fake-dom';
import { attachRef, byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { SolidContext, SolidRuntime } from '../theme/solid-adapter';
import { Dialog } from './Dialog';
import { Drawer } from './Drawer';
import { Menu } from './Menu';
import { Popover } from './Popover';

interface Runtime {
  flush(): void;
  cleanup(): void;
  restore(): void;
}

/** Queued effects and cleanups — nothing here decides anything the components decide. */
function runtime(): Runtime {
  const effects: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const rt: SolidRuntime = {
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol('test.context'),
      defaultValue,
      Provider: (props: { children?: unknown }) => props.children as never,
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      const set = (next: T): void => {
        current = next;
      };
      return [(): T => current, set] as [() => T, (next: T) => void];
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: (fn: () => void): void => void effects.push(fn),
    onCleanup: (fn: () => void): void => void cleanups.push(fn),
  };
  setSolidRuntime(rt);
  probe();
  return {
    // Re-runnable, the way Solid re-runs an effect when a dependency changes — an effect that is
    // only ever run once cannot be caught doing its work twice.
    flush: () => {
      for (const effect of effects) effect();
    },
    cleanup: () => {
      for (const fn of cleanups.splice(0)) fn();
    },
    restore: () => {
      unprobe();
      clearSolidRuntime();
    },
  };
}

/** The `<dialog>` API the two modal components use, and nothing else. */
interface FakeDialog {
  open: boolean;
  readonly calls: string[];
  showModal(): void;
  close(): void;
}

function fakeDialog(open = false): FakeDialog {
  const dialog: FakeDialog = {
    open,
    calls: [],
    showModal(): void {
      dialog.calls.push('showModal');
      dialog.open = true;
    },
    close(): void {
      dialog.calls.push('close');
      dialog.open = false;
    },
  };
  return dialog;
}

describe('the modal overlays', () => {
  afterEach(clearSolidRuntime);

  for (const [name, Component] of [
    ['Dialog', Dialog],
    ['Drawer', Drawer],
  ] as const) {
    describe(name, () => {
      const props = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        open: true,
        title: 'Confirm',
        children: 'body',
        onClose: (): void => undefined,
        ...extra,
      });

      test('opens the native dialog in the top layer once the tree exists', () => {
        const rt = runtime();
        try {
          const nodes = renderNodes(Component, props());
          const element = fakeDialog();
          attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), element);
          // The effect is DOM work; it has not run during the render.
          expect(element.calls).toEqual([]);

          rt.flush();
          expect(element.calls).toEqual(['showModal']);
          // Idempotent: a second pass must not re-open an already-open dialog.
          rt.flush();
          expect(element.calls).toEqual(['showModal']);
        } finally {
          rt.restore();
        }
      });

      test('closes a dialog the browser still has open when open goes false', () => {
        const rt = runtime();
        try {
          const nodes = renderNodes(Component, props({ open: false }));
          const element = fakeDialog(true);
          attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), element);

          rt.flush();
          expect(element.calls).toEqual(['close']);
        } finally {
          rt.restore();
        }
      });

      test('an unattached ref is a no-op, not a crash on the server', () => {
        const rt = runtime();
        try {
          renderNodes(Component, props());
          expect(() => rt.flush()).not.toThrow();
        } finally {
          rt.restore();
        }
      });

      test('Escape closes through onCancel, and the default close is prevented first', () => {
        const rt = runtime();
        try {
          let closed = 0;
          let prevented = 0;
          const nodes = renderNodes(Component, props({ onClose: () => (closed += 1) }));
          fire(one(byTag(nodes, 'dialog'), '<dialog>'), 'onCancel', {
            preventDefault: () => (prevented += 1),
          });
          // The component owns the close, so the platform's own must not race it.
          expect(prevented).toBe(1);
          expect(closed).toBe(1);
        } finally {
          rt.restore();
        }
      });

      test('a click on the panel is not a click on the backdrop', () => {
        const rt = runtime();
        try {
          let closed = 0;
          const nodes = renderNodes(Component, props({ onClose: () => (closed += 1) }));
          const dialogNode = one(byTag(nodes, 'dialog'), '<dialog>');
          const element = fakeDialog();
          attachRef(dialogNode, element);

          fire(dialogNode, 'onClick', { target: { not: 'the dialog' } });
          expect(closed).toBe(0);

          fire(dialogNode, 'onClick', { target: element });
          expect(closed).toBe(1);
        } finally {
          rt.restore();
        }
      });

      test('the title is the accessible name, wired to the heading it rendered', () => {
        const rt = runtime();
        try {
          const nodes = renderNodes(Component, props());
          const heading = one(byTag(nodes, 'h2'), 'dialog heading');
          expect(heading.props['children']).toBe('Confirm');
          expect(one(byTag(nodes, 'dialog'), '<dialog>').props['aria-labelledby']).toBe(
            heading.props['id'],
          );
        } finally {
          rt.restore();
        }
      });

      test('the footer is absent unless given', () => {
        const rt = runtime();
        try {
          expect(byTag(renderNodes(Component, props()), 'footer')).toEqual([]);
          expect(
            one(byTag(renderNodes(Component, props({ footer: 'ok' })), 'footer'), 'footer').props[
              'children'
            ],
          ).toBe('ok');
        } finally {
          rt.restore();
        }
      });
    });
  }

  test('Dialog can refuse backdrop dismissal, which Drawer never offers', () => {
    const rt = runtime();
    try {
      let closed = 0;
      const nodes = renderNodes(Dialog, {
        open: true,
        title: 'Delete everything',
        children: 'body',
        dismissOnBackdrop: false,
        onClose: () => (closed += 1),
      });
      const dialogNode = one(byTag(nodes, 'dialog'), '<dialog>');
      const element = fakeDialog();
      attachRef(dialogNode, element);

      fire(dialogNode, 'onClick', { target: element });
      expect(closed).toBe(0);
    } finally {
      rt.restore();
    }
  });
});

/** Popover and Menu share one effect shape: dismiss on outside pointerdown, dismiss on Escape. */
describe('the anchored overlays', () => {
  afterEach(clearSolidRuntime);

  interface Wired {
    readonly dom: InstalledDom;
    readonly outside: FakeElement;
    readonly panel: FakeElement;
    readonly closes: boolean[];
  }

  const popoverProps = (closes: boolean[]): Record<string, unknown> => ({
    open: true,
    label: 'Details',
    children: 'body',
    onOpenChange: (open: boolean) => void closes.push(open),
    trigger: (): string => 'open',
  });

  const menuProps = (closes: boolean[], items: readonly unknown[]): Record<string, unknown> => ({
    open: true,
    label: 'Actions',
    items,
    onOpenChange: (open: boolean) => void closes.push(open),
    trigger: (): string => 'open',
  });

  /** Build the two elements the component refs, install them as the document, run the effect. */
  function wire(
    rt: Runtime,
    nodes: ReturnType<typeof renderNodes>,
    panelRole: string,
    panelTag: string,
    closes: boolean[],
  ): Wired {
    const panel = new FakeElement(panelTag, { role: panelRole });
    const item = new FakeElement('button');
    panel.append(item);
    const root = new FakeElement('div');
    root.append(panel);
    const outside = new FakeElement('div');
    const page = new FakeElement('body');
    page.append(root, outside);

    const dom = installFakeDom(page);
    attachRef(nodes[0] as never, root);
    attachRef(one(withAttr(nodes, 'role', panelRole), panelRole), panel);
    rt.flush();
    return { dom, outside, panel, closes };
  }

  test('Popover moves focus into the panel and dismisses on outside pointerdown', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    const nodes = renderNodes(Popover, popoverProps(closes));
    const w = wire(rt, nodes, 'dialog', 'div', closes);
    try {
      // The trap's whole job: a panel opened with nothing focusable behind it would drop focus
      // to <body> the moment it closes.
      expect(w.dom.document.activeElement).toBe(w.panel.children[0] as FakeElement);

      w.dom.document.dispatch('pointerdown', { target: w.panel.children[0] });
      expect(closes).toEqual([]);

      w.dom.document.dispatch('pointerdown', { target: w.outside });
      expect(closes).toEqual([false]);
    } finally {
      w.dom.restore();
      rt.restore();
    }
  });

  test('Popover dismisses on Escape and on nothing else', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    const nodes = renderNodes(Popover, popoverProps(closes));
    const w = wire(rt, nodes, 'dialog', 'div', closes);
    try {
      w.dom.document.dispatch('keydown', keydown('a'));
      expect(closes).toEqual([]);

      w.dom.document.dispatch('keydown', keydown('Escape'));
      expect(closes).toEqual([false]);
    } finally {
      w.dom.restore();
      rt.restore();
    }
  });

  test('Popover detaches both document listeners on cleanup', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    const nodes = renderNodes(Popover, popoverProps(closes));
    const w = wire(rt, nodes, 'dialog', 'div', closes);
    try {
      rt.cleanup();

      w.dom.document.dispatch('keydown', keydown('Escape'));
      w.dom.document.dispatch('pointerdown', { target: w.outside });
      // A closed popover that still listens closes the NEXT one the user opens.
      expect(closes).toEqual([]);
    } finally {
      w.dom.restore();
      rt.restore();
    }
  });

  test('a closed Popover renders no panel and installs no listeners', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    try {
      const nodes = renderNodes(Popover, { ...popoverProps(closes), open: false });
      expect(withAttr(nodes, 'role', 'dialog')).toEqual([]);
      expect(() => rt.flush()).not.toThrow();
    } finally {
      rt.restore();
    }
  });

  test('the trigger is told what it controls and whether it is expanded', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    try {
      let control: Record<string, unknown> = {};
      const nodes = renderNodes(Popover, {
        ...popoverProps(closes),
        trigger: (c: Record<string, unknown>) => {
          control = c;
          return null;
        },
      });
      const panel = one(withAttr(nodes, 'role', 'dialog'), 'panel');
      expect(control['aria-expanded']).toBe(true);
      expect(control['aria-controls']).toBe(panel.props['id']);
      expect(String(control['id'])).toContain(String(panel.props['id']));
    } finally {
      rt.restore();
    }
  });

  test('Menu dismisses on Escape and on an outside pointerdown, then stops on cleanup', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    const items = [{ id: 'edit', label: 'Edit', onSelect: (): void => undefined }];
    const nodes = renderNodes(Menu, menuProps(closes, items));
    const w = wire(rt, nodes, 'menu', 'div', closes);
    try {
      w.dom.document.dispatch('keydown', keydown('Escape'));
      w.dom.document.dispatch('pointerdown', { target: w.outside });
      expect(closes).toEqual([false, false]);

      rt.cleanup();
      w.dom.document.dispatch('keydown', keydown('Escape'));
      expect(closes).toEqual([false, false]);
    } finally {
      w.dom.restore();
      rt.restore();
    }
  });

  test('choosing an item runs its action and then closes the menu', () => {
    const rt = runtime();
    const closes: boolean[] = [];
    const order: string[] = [];
    try {
      const nodes = renderNodes(
        Menu,
        menuProps(closes, [
          { id: 'edit', label: 'Edit', icon: 'pencil', onSelect: () => order.push('edit') },
          { id: 'rm', label: 'Delete', destructive: true, onSelect: () => order.push('rm') },
        ]),
      );

      const buttons = byTag(nodes, 'button');
      expect(buttons).toHaveLength(2);
      fire(buttons[1] as never, 'onClick', {});

      expect(order).toEqual(['rm']);
      expect(closes).toEqual([false]);
      // The icon slot is decoration beside the label, and absent where no icon was given.
      expect(withAttr(nodes, 'aria-hidden', 'true').map((node) => node.props['children'])).toEqual([
        'pencil',
      ]);
    } finally {
      rt.restore();
    }
  });
});
