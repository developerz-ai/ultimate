// The DOM readers behind a virtual list: the anchor is the drawn row the box's top edge falls in
// (never one wholly above it), a row's offset is read against the box, and the one ResizeObserver
// batches its reports into the next frame — box height and row heights by `data-key`.

import { afterEach, describe, expect, test } from 'bun:test';
import { fakeFrames, installGlobals } from '../browser-fake-fixture';
import { domRowOffset, readDomAnchor } from './virtual-list-anchor';
import { createVirtualListObserver, type VirtualListSizes } from './virtual-list-observer';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const box = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as never;
const row = (key: string | undefined, top: number, height: number) =>
  ({
    dataset: key === undefined ? {} : { key },
    getBoundingClientRect: () => ({ top, bottom: top + height }),
  }) as never;

describe('readDomAnchor', () => {
  test('the first row still showing at the edge, and how far the edge is into it', () => {
    const rows = [row('c', 160, 40), row('a', 60, 40), row('b', 100, 60), row(undefined, 105, 10)];
    expect(readDomAnchor(box(110), rows)).toEqual({ key: 'b', within: 10 });
  });

  test('a row ending exactly at the edge is above it; with none showing there is no anchor', () => {
    expect(readDomAnchor(box(100), [row('a', 60, 40), row('b', 100, 20)])).toEqual({
      key: 'b',
      within: 0,
    });
    expect(readDomAnchor(box(100), [row('a', 60, 40)])).toBeUndefined();
    expect(readDomAnchor(box(100), [])).toBeUndefined();
  });
});

describe('domRowOffset', () => {
  test('the row named, relative to the box top; an undrawn one is undefined', () => {
    const rows = [row('a', 60, 40), row('b', 130, 40)];
    expect(domRowOffset(box(100), rows, 'b')).toBe(30);
    expect(domRowOffset(box(100), rows, 'a')).toBe(-40);
    expect(domRowOffset(box(100), rows, 'z')).toBeUndefined();
  });
});

describe('createVirtualListObserver', () => {
  test('no ResizeObserver: no observer, and the estimate stands', () => {
    expect(createVirtualListObserver({} as never, () => {})).toBeUndefined();
  });

  const harness = () => {
    const frames = fakeFrames();
    const instances: FakeObserver[] = [];
    class FakeObserver {
      readonly watched = new Set<unknown>();
      disconnected = false;
      constructor(readonly callback: (entries: readonly unknown[]) => void) {
        instances.push(this);
      }
      observe(el: unknown): void {
        this.watched.add(el);
      }
      unobserve(el: unknown): void {
        this.watched.delete(el);
      }
      disconnect(): void {
        this.disconnected = true;
      }
    }
    restore = installGlobals({
      ResizeObserver: FakeObserver,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    });
    const target = { clientHeight: 480 };
    const reports: VirtualListSizes[] = [];
    const observer = createVirtualListObserver(target as never, (sizes) => reports.push(sizes));
    const instance = instances[0];
    if (instance === undefined) expect.unreachable('createVirtualListObserver built no observer');
    return { frames, target, reports, observer, instance };
  };

  const entry = (target: unknown, block: number | undefined, height = 0) => ({
    target,
    borderBoxSize: block === undefined ? [] : [{ blockSize: block }],
    contentRect: { height },
  });

  test('the box is watched from the start; entries are reported once, a frame later', () => {
    const h = harness();
    expect(h.instance.watched.has(h.target)).toBe(true);
    const a = { dataset: { key: 'a' } };
    const b = { dataset: { key: 'b' } };
    const keyless = { dataset: {} };
    h.instance.callback([entry(h.target, 1), entry(a, 31), entry(b, undefined, 44)]);
    h.instance.callback([entry(keyless, 10)]);
    expect(h.reports).toEqual([]);
    expect(h.frames.pending()).toBe(1);
    h.frames.run();
    expect(h.reports).toEqual([
      {
        viewport: 480,
        rows: new Map([
          ['a', 31],
          ['b', 44],
        ]),
      },
    ]);
    h.instance.callback([entry(a, 32)]);
    h.frames.run();
    expect(h.reports[1]).toEqual({ viewport: undefined, rows: new Map([['a', 32]]) });
  });

  test('observe and unobserve pass through; disconnect cancels a pending frame', () => {
    const h = harness();
    const el = { dataset: { key: 'a' } };
    h.observer?.observe(el as never);
    expect(h.instance.watched.has(el)).toBe(true);
    h.observer?.unobserve(el as never);
    expect(h.instance.watched.has(el)).toBe(false);
    h.instance.callback([entry(el, 5)]);
    h.observer?.disconnect();
    expect(h.instance.disconnected).toBe(true);
    expect(h.frames.pending()).toBe(0);
    h.frames.run();
    expect(h.reports).toEqual([]);
  });
});
