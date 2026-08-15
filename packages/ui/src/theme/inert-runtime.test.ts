// What the inert runtime must NOT do comes first: every effect in this package is DOM work, so an
// effect that ran on the server would call showModal(), addEventListener() or new
// IntersectionObserver() against a host that has none — a crash in the middle of a page render.

import { describe, expect, test } from 'bun:test';
import { INERT_SOLID_RUNTIME } from './inert-runtime';

const rt = INERT_SOLID_RUNTIME;

describe('INERT_SOLID_RUNTIME', () => {
  test('createEffect never runs the function it is given', () => {
    let ran = false;
    rt.createEffect(() => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  test('onCleanup never runs either — nothing was set up to tear down', () => {
    let ran = false;
    rt.onCleanup(() => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  test('useContext answers with the default value, which is the only value an inert tree has', () => {
    const context = rt.createContext('default');
    expect(rt.useContext(context)).toBe('default');
  });

  test('a Provider passes its children through and provides nothing', () => {
    const context = rt.createContext('default');
    const children = { marker: true } as never;
    expect(context.Provider({ value: 'provided', children })).toBe(children);
    expect(rt.useContext(context)).toBe('default');
  });

  test('createSignal round-trips a write, so a value derived during render reads back', () => {
    const [read, write] = rt.createSignal(1);
    expect(read()).toBe(1);
    write(2);
    expect(read()).toBe(2);
  });

  test('createMemo recomputes on read rather than caching a first answer', () => {
    let calls = 0;
    const memo = rt.createMemo(() => {
      calls += 1;
      return calls;
    });
    expect(memo()).toBe(1);
    expect(memo()).toBe(2);
  });

  test('two contexts from the same runtime are distinct, as a real createContext gives', () => {
    expect(rt.createContext('a').id).not.toBe(rt.createContext('a').id);
  });

  // uiContext() caches its context keyed on runtime identity: a per-call runtime would rebuild it
  // on every read and hand two consumers contexts that are equal without being the same.
  test('the runtime is a single frozen instance', () => {
    expect(Object.isFrozen(INERT_SOLID_RUNTIME)).toBe(true);
  });
});
