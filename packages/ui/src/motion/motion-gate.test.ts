// The one answer to "may this page move?": the OS asking for less motion, and the reader having
// paused it (`<MotionToggle>`), each a reason on its own.

import { describe, expect, test } from 'bun:test';
import { installGlobals } from '../browser-fake-fixture';
import {
  browserMotionHost,
  type MotionHost,
  motionAllowed,
  onMotionChange,
  setMotionPaused,
} from './motion-gate';

function fakeHost(): MotionHost & { set(reduced: boolean, paused: boolean): void } {
  let state = { reduced: false, paused: false };
  const watchers = new Set<() => void>();
  return {
    reduced: () => state.reduced,
    paused: () => state.paused,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    set(reduced, paused) {
      state = { reduced, paused };
      for (const fn of watchers) fn();
    },
  };
}

describe('motionAllowed', () => {
  test('moves only when neither the OS nor the reader said stop', () => {
    const host = fakeHost();
    expect(motionAllowed(host)).toBe(true);
    host.set(true, false);
    expect(motionAllowed(host)).toBe(false);
    host.set(false, true);
    expect(motionAllowed(host)).toBe(false);
  });

  test('off the DOM nothing moves', () => {
    expect(browserMotionHost()).toBeNull();
    expect(motionAllowed()).toBe(false);
  });
});

describe('onMotionChange', () => {
  test('reports a change of the answer, once, and never a repeat', () => {
    const host = fakeHost();
    const heard: boolean[] = [];
    const stop = onMotionChange((allowed) => heard.push(allowed), host);
    host.set(true, false);
    host.set(true, true); // still not allowed: no report
    host.set(false, false);
    stop();
    host.set(true, false);
    expect(heard).toEqual([false, true]);
  });
});

describe('the browser host', () => {
  test('reads the media query and html[data-motion]; setMotionPaused writes both halves', () => {
    const attrs = new Map<string, string>();
    const stored = new Map<string, string>();
    const html = {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };
    const restore = installGlobals({
      window: {},
      document: { documentElement: html },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    try {
      expect(motionAllowed()).toBe(true);
      setMotionPaused(true);
      expect(attrs.get('data-motion')).toBe('paused');
      expect([...stored.values()]).toEqual(['paused']);
      expect(motionAllowed()).toBe(false);
      setMotionPaused(false);
      expect(attrs.has('data-motion')).toBe(false);
      expect(stored.size).toBe(0);
      expect(motionAllowed()).toBe(true);
    } finally {
      restore();
    }
  });
});
