import { describe, expect, test } from 'bun:test';
import { mountCanvas } from './canvas-mount';
import { asCanvas, FakeCanvas, FakeHost } from './fake-host-fixture';

describe('unit · canvas mount', () => {
  test('draws frame 0 first, in CSS pixels, on a context pre-scaled to the budget', () => {
    const canvas = new FakeCanvas();
    const host = new FakeHost();
    const frames: number[] = [];
    mountCanvas(asCanvas(canvas), (_ctx, frame) => frames.push(frame.time), host, { speed: 1 });
    host.frame();
    host.frame(250);
    expect(frames).toEqual([0, 0.1]);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(canvas.ctx?.calls[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
  });

  test('a canvas with no 2D context answers undefined and holds nothing', () => {
    const canvas = new FakeCanvas();
    canvas.ctx = null;
    const host = new FakeHost();
    expect(mountCanvas(asCanvas(canvas), () => {}, host, { speed: 1 })).toBeUndefined();
    expect(host.live()).toBe(0);
  });

  test('the answer stops the loop and the size observer', () => {
    const canvas = new FakeCanvas();
    const host = new FakeHost();
    let drawn = 0;
    const stop = mountCanvas(asCanvas(canvas), () => drawn++, host, { speed: 1 });
    stop?.();
    host.frame();
    expect(drawn).toBe(0);
    expect(host.live()).toBe(0);
  });
});
