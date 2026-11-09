// The ways around an app, wired: one current link per list by position, a bar that refuses a
// sixth destination, a sheet that closes when dragged past half from its grabber, and a pull that
// refreshes once. The rules have their own tests beside each `*-view.ts`; this is the WIRING.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, one, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { AppShell } from './AppShell';
import { BottomNav } from './BottomNav';
import { Drawer } from './Drawer';
import { NavList } from './NavList';
import { type PullState, pullController } from './pull-refresh-view';
import { Stepper } from './Stepper';

const current = (nodes: ReturnType<typeof renderNodes>): unknown[] =>
  withAttr(nodes, 'aria-current', 'page').map((node) => node.props['href']);

describe('NavList and BottomNav mark one current link', () => {
  test('NavList: /runs/7 marks /runs inside its group, and the group holding it is open', () => {
    const nodes = renderNodes(NavList, {
      currentHref: '/runs/7',
      items: [
        { label: 'Home', href: '/' },
        { label: 'Work', collapsible: true, items: [{ label: 'Runs', href: '/runs' }] },
        { label: 'Settings', href: '/settings' },
      ],
    });
    expect(current(nodes)).toEqual(['/runs']);
    expect(one(byTag(nodes, 'details'), '<details>').props['open']).toBe(true);
    expect(byTag(nodes, 'nav')).toHaveLength(0);
  });

  test('BottomNav: a <nav> of links, one current; a sixth item is X_UI_INVALID_VALUE', () => {
    const item = (href: string) => ({ label: href, href, icon: null });
    const nodes = renderNodes(BottomNav, {
      currentHref: '/feed',
      items: [item('/'), item('/feed'), item('/runs')],
    });
    expect(byTag(nodes, 'nav')).toHaveLength(1);
    expect(current(nodes)).toEqual(['/feed']);
    expect(() =>
      renderNodes(BottomNav, {
        currentHref: '/',
        items: ['/a', '/b', '/c', '/d', '/e', '/f'].map(item),
      }),
    ).toThrow('6 items');
  });

  test('AppShell renders the bottom bar after the footer, and only when given one', () => {
    const without = renderNodes(AppShell, { children: 'body', footer: 'f' });
    const withBar = renderNodes(AppShell, {
      children: 'body',
      footer: 'f',
      bottomNav: renderNodes(BottomNav, {
        currentHref: '/',
        items: [{ label: 'Home', href: '/', icon: null }],
      }),
    });
    expect(byTag(without, 'nav')).toHaveLength(0);
    expect(byTag(withBar, 'nav')).toHaveLength(1);
  });
});

describe('Stepper', () => {
  test('one aria-current="step"; a passed step with a href is a link, an upcoming one text', () => {
    const nodes = renderNodes(Stepper, {
      label: 'New post',
      steps: [
        { id: 'write', label: 'Write', href: '/posts/new', state: 'done' },
        { id: 'review', label: 'Review', state: 'current' },
        { id: 'publish', label: 'Publish', state: 'upcoming' },
      ],
    });
    expect(withAttr(nodes, 'aria-current', 'step')).toHaveLength(1);
    expect(byTag(nodes, 'a').map((a) => a.props['href'])).toEqual(['/posts/new']);
    expect(byTag(nodes, 'ol')).toHaveLength(1);
  });
});

describe('Drawer as a bottom sheet', () => {
  const sheet = (onClose: () => void) =>
    renderNodes(Drawer, {
      open: true,
      title: 'Comments',
      side: 'block-end',
      grabber: true,
      onClose,
      children: 'body',
    });

  /** The `<dialog>` the drag reads its height from and writes its offset to. */
  const fakeDialog = () => {
    const props = new Map<string, string>();
    return {
      props,
      getBoundingClientRect: () => ({ height: 400 }),
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
      },
      setAttribute: () => {},
      removeAttribute: () => {},
    };
  };
  const pointer = (clientY: number) => ({
    pointerId: 1,
    clientY,
    currentTarget: { setPointerCapture: () => {} },
  });

  test('dragged from the grabber past half its height, it closes; the body has no handler', () => {
    let closed = 0;
    const nodes = sheet(() => (closed += 1));
    const dialog = fakeDialog();
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), dialog);
    const grabber = one(
      withAttr(nodes, 'aria-hidden', 'true').filter((n) => n.props['onPointerDown'] !== undefined),
      'grabber',
    );
    fire(grabber, 'onPointerDown', pointer(100));
    fire(grabber, 'onPointerMove', pointer(250));
    expect(dialog.props.get('--drawer-drag')).toBe('150px');
    fire(grabber, 'onPointerUp', pointer(301));
    expect(closed).toBe(1);
    expect(dialog.props.has('--drawer-drag')).toBe(false);
  });

  test('a short drag settles back, and a cancelled one never closes', () => {
    let closed = 0;
    const nodes = sheet(() => (closed += 1));
    attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), fakeDialog());
    const grabber = one(
      withAttr(nodes, 'aria-hidden', 'true').filter((n) => n.props['onPointerDown'] !== undefined),
      'grabber',
    );
    fire(grabber, 'onPointerDown', pointer(100));
    fire(grabber, 'onPointerUp', pointer(150));
    fire(grabber, 'onPointerDown', pointer(100));
    fire(grabber, 'onPointerCancel', pointer(400));
    expect(closed).toBe(0);
  });

  test('without a grabber, or on another side, there is no drag at all', () => {
    const side = renderNodes(Drawer, {
      open: true,
      title: 'Filters',
      side: 'inline-end',
      grabber: true,
      onClose: () => {},
      children: 'body',
    });
    expect(byTag(side, 'div').filter((n) => n.props['onPointerDown'] !== undefined)).toHaveLength(
      0,
    );
  });
});

describe('PullToRefresh, the controller its touches drive', () => {
  const pullOnce = (
    send: (event: Parameters<ReturnType<typeof pullController>['send']>[0]) => void,
  ) => {
    send({ type: 'start', atTop: true, touch: true });
    send({ type: 'move', dy: 400 });
    send({ type: 'end' });
  };

  test('a double pull during a refresh calls onRefresh once', async () => {
    let calls = 0;
    let finish: () => void = () => {};
    const pull = pullController(
      () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      () => {},
      () => {},
    );
    pullOnce(pull.send);
    pullOnce(pull.send);
    expect(calls).toBe(1);
    finish();
    await Promise.resolve();
    expect(pull.state().kind).toBe('idle');
  });

  test('a rejected refresh ends the busy state and reaches onError', async () => {
    const seen: PullState['kind'][] = [];
    const errors: unknown[] = [];
    const pull = pullController(
      () => Promise.reject(new Error('offline')),
      (state) => seen.push(state.kind),
      (error) => errors.push(error),
    );
    pullOnce(pull.send);
    await Promise.resolve();
    await Promise.resolve();
    expect(pull.state().kind).toBe('idle');
    expect(seen.at(-1)).toBe('idle');
    expect(seen).toContain('refreshing');
    expect(errors).toHaveLength(1);
  });

  test('an onRefresh that throws before its promise ends the busy state and reaches onError', async () => {
    const errors: unknown[] = [];
    const boom = new TypeError('not a function');
    const pull = pullController(
      () => {
        throw boom;
      },
      () => {},
      (error) => errors.push(error),
    );
    expect(() => pullOnce(pull.send)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(pull.state().kind).toBe('idle');
    expect(errors).toEqual([boom]);
  });

  test('a pull mid-list never refreshes', () => {
    let calls = 0;
    const pull = pullController(
      () => {
        calls += 1;
        return Promise.resolve();
      },
      () => {},
      () => {},
    );
    pull.send({ type: 'start', atTop: false, touch: true });
    pull.send({ type: 'move', dy: 400 });
    pull.send({ type: 'end' });
    expect(calls).toBe(0);
  });
});
