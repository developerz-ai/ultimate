import { describe, expect, test } from 'bun:test';
import { FakeHost } from '../fake-host-fixture';
import { runCountUp } from './count-up-run';

const el = {} as Element;
const run = { from: 0, to: 100, ms: 100, format: (n: number) => `#${Math.round(n)}` };

describe('runCountUp', () => {
  test('counts up frame by frame and ends exactly on the final text, then stops', () => {
    const host = new FakeHost();
    const node = { textContent: 'final' };
    runCountUp(node, el, run, host);
    expect(node.textContent).toBe('#0');
    host.frame(50);
    const mid = Number(node.textContent?.slice(1));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    host.frame(60);
    expect(node.textContent).toBe('#100');
    expect(host.ticks.size).toBe(0);
  });

  test('reduced motion leaves the server text alone and starts nothing', () => {
    const host = new FakeHost();
    host.allowedNow = false;
    const node = { textContent: 'final' };
    runCountUp(node, el, run, host)();
    expect(node.textContent).toBe('final');
    expect(host.ticks.size).toBe(0);
  });

  test('ms 0 starts nothing', () => {
    const host = new FakeHost();
    runCountUp({ textContent: 'x' }, el, { ...run, ms: 0 }, host);
    expect(host.ticks.size).toBe(0);
  });

  test('cleanup mid-tween stops the loop and restores the final text', () => {
    const host = new FakeHost();
    const node = { textContent: '' };
    const cleanup = runCountUp(node, el, run, host);
    host.frame(10);
    cleanup();
    expect(host.ticks.size).toBe(0);
    expect(node.textContent).toBe('#100');
  });
});
