// One port, many installers, any stop order: a release removes its OWN frame and nothing else, so a
// boot that stops first never reverts the slot under a boot still serving, and a second release
// never clobbers a later install.

import { describe, expect, test } from 'bun:test';
import { adapterSlot } from './adapter-slot';

const slot = () => adapterSlot<string>(() => 'fallback');

describe('adapterSlot', () => {
  test('is the fallback until something installs', () => {
    expect(slot().current()).toBe('fallback');
    expect(adapterSlot<string | undefined>(() => undefined).current()).toBeUndefined();
  });

  test('in order: install A, B; release B, A', () => {
    const s = slot();
    const releaseA = s.install('A');
    const releaseB = s.install('B');
    expect(s.current()).toBe('B');
    releaseB();
    expect(s.current()).toBe('A');
    releaseA();
    expect(s.current()).toBe('fallback');
  });

  test('out of order: releasing A keeps B, releasing B falls back', () => {
    const s = slot();
    const releaseA = s.install('A');
    const releaseB = s.install('B');
    releaseA();
    expect(s.current()).toBe('B');
    releaseB();
    expect(s.current()).toBe('fallback');
  });

  test('a second release is a no-op', () => {
    const s = slot();
    s.install('A');
    const releaseB = s.install('B');
    releaseB();
    releaseB();
    expect(s.current()).toBe('A');
  });

  test('a release after a later install keeps the later one', () => {
    const s = slot();
    const releaseA = s.install('A');
    releaseA();
    s.install('C');
    releaseA();
    expect(s.current()).toBe('C');
  });

  test('the same value installed twice is two frames', () => {
    const s = slot();
    s.install('A');
    const second = s.install('A');
    second();
    expect(s.current()).toBe('A');
  });

  test('reset drops every frame', () => {
    const s = slot();
    s.install('A');
    s.install('B');
    s.reset();
    expect(s.current()).toBe('fallback');
  });

  test('the fallback is read at each call, never captured', () => {
    let fallback = 'one';
    const s = adapterSlot<string>(() => fallback);
    fallback = 'two';
    expect(s.current()).toBe('two');
  });
});
