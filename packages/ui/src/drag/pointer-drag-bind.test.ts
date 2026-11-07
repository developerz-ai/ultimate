// The binder's half of the gesture, on a listener book: the press captures the pointer, a drag's
// move refuses the page scroll, Escape on the document / a window blur / a lost capture cancel,
// a secondary button never presses, and the unbind leaves no listener anywhere. Plus the browser
// frame clock `browserScrollEnv` reads, delegated to the globals it names.

import { afterEach, describe, expect, test } from 'bun:test';
import { fakeFrames, fakeMatchMedia, installGlobals } from '../browser-fake-fixture';
import { FakeDocument, FakeElement } from '../fake-dom-fixture';
import { bindPointerDrag, browserScrollEnv, type DragHandlers } from './pointer-drag';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const world = () => {
  const doc = new FakeDocument();
  const win = new FakeDocument();
  restore = installGlobals({ document: doc, window: win });
  const handle = new FakeElement('button');
  const captured: number[] = [];
  Object.assign(handle, { setPointerCapture: (id: number) => captured.push(id) });
  const calls: string[] = [];
  const handlers: DragHandlers = {
    start: (p) => calls.push(`start ${p.x},${p.y}`),
    move: (p) => calls.push(`move ${p.x},${p.y}`),
    drop: (p) => calls.push(`drop ${p.x},${p.y}`),
    cancel: () => calls.push('cancel'),
  };
  const unbind = bindPointerDrag(handle as unknown as HTMLElement, handlers);
  return { doc, win, handle, captured, calls, unbind };
};

const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) => {
  const event = {
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
    pointerId: 7,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
    ...extra,
  };
  return event;
};

describe('bindPointerDrag', () => {
  test('press captures, travel lifts at the press point, release drops; a drag move is prevented', () => {
    const w = world();
    w.handle.dispatch('pointerdown', pointer(10, 10));
    expect(w.captured).toEqual([7]);
    const small = pointer(11, 11);
    w.handle.dispatch('pointermove', small);
    expect(small.prevented).toBe(false);
    const far = pointer(10, 40);
    w.handle.dispatch('pointermove', far);
    expect(far.prevented).toBe(true);
    w.handle.dispatch('pointerup', pointer(10, 50));
    expect(w.calls).toEqual(['start 10,10', 'move 10,40', 'drop 10,50']);
  });

  test('a move with nothing pressed is ignored, and a secondary or non-primary press never presses', () => {
    const w = world();
    w.handle.dispatch('pointermove', pointer(0, 90));
    w.handle.dispatch('pointerdown', pointer(0, 0, { button: 2 }));
    w.handle.dispatch('pointerdown', pointer(0, 0, { isPrimary: false }));
    w.handle.dispatch('pointermove', pointer(0, 90));
    expect(w.captured).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  for (const [name, fire] of [
    [
      'Escape on the document',
      (w: ReturnType<typeof world>) => w.doc.dispatch('keydown', { key: 'Escape' }),
    ],
    ['a window blur', (w: ReturnType<typeof world>) => w.win.dispatch('blur', {})],
    [
      'a lost capture',
      (w: ReturnType<typeof world>) => w.handle.dispatch('lostpointercapture', {}),
    ],
    ['pointercancel', (w: ReturnType<typeof world>) => w.handle.dispatch('pointercancel', {})],
  ] as const) {
    test(`${name} cancels a drag`, () => {
      const w = world();
      w.handle.dispatch('pointerdown', pointer(0, 0));
      w.handle.dispatch('pointermove', pointer(0, 30));
      fire(w);
      w.handle.dispatch('pointerup', pointer(0, 40));
      expect(w.calls).toEqual(['start 0,0', 'move 0,30', 'cancel']);
    });
  }

  test('a key other than Escape, or Escape with no drag, cancels nothing', () => {
    const w = world();
    w.doc.dispatch('keydown', { key: 'Escape' });
    w.handle.dispatch('pointerdown', pointer(0, 0));
    w.handle.dispatch('pointermove', pointer(0, 30));
    w.doc.dispatch('keydown', { key: 'Enter' });
    w.handle.dispatch('pointerup', pointer(0, 31));
    expect(w.calls).toEqual(['start 0,0', 'move 0,30', 'drop 0,31']);
  });

  test('the unbind removes every listener it added, on the handle, the document and the window', () => {
    const w = world();
    w.unbind();
    const live = (book: FakeDocument | FakeElement): number =>
      [...book.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(live(w.handle)).toBe(0);
    expect(live(w.doc)).toBe(0);
    expect(live(w.win)).toBe(0);
  });
});

describe('browserScrollEnv', () => {
  test('frames, cancel, the clock and reduced motion are the browser’s own', () => {
    const frames = fakeFrames();
    let reduced = true;
    const query = '(prefers-reduced-motion: reduce)';
    restore = installGlobals({
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
      matchMedia: (q: string) => fakeMatchMedia(new Map([[query, reduced]]))(q),
    });
    const env = browserScrollEnv();
    let ran = 0;
    const handle = env.frame(() => (ran += 1));
    expect(frames.pending()).toBe(1);
    env.cancelFrame(handle);
    expect(frames.pending()).toBe(0);
    env.frame(() => (ran += 1));
    frames.run();
    expect(ran).toBe(1);
    expect(env.reducedMotion()).toBe(true);
    reduced = false;
    expect(env.reducedMotion()).toBe(false);
    const before = performance.now();
    const at = env.now();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(performance.now());
    expect(at).toBeGreaterThan(0);
  });
});
