// TEST-ONLY. The browser globals a component's DOM half reads (`window`, `matchMedia`, a frame
// clock), installed for one test and put back exactly as found, plus a runtime whose effects run
// at once. A fake here answers only what it was told; anything else throws, so a test can never
// pass on behaviour this file made up.

import { assert } from '@ultimat3/core';
import { INERT_SOLID_RUNTIME } from './theme/inert-runtime';
import type { SolidRuntime } from './theme/solid-adapter';

/** Install `globals` on `globalThis`; the answer restores each name to what it was, or deletes it. */
export function installGlobals(globals: Readonly<Record<string, unknown>>): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

/** `matchMedia` that knows only the queries it was given; any other is a test bug, thrown. */
export function fakeMatchMedia(
  answers: ReadonlyMap<string, boolean>,
): (query: string) => { matches: boolean } {
  return (query) => {
    const matches = answers.get(query);
    assert(
      matches !== undefined,
      `fakeMatchMedia has no answer for ${query}`,
      'pass the query to fakeMatchMedia(new Map([[query, true]]))',
    );
    return { matches };
  };
}

/** A frame clock a test steps by hand: `run()` fires every queued frame once. */
export interface FakeFrames {
  readonly request: (fn: () => void) => number;
  readonly cancel: (handle: number) => void;
  readonly pending: () => number;
  readonly run: () => void;
}

export function fakeFrames(): FakeFrames {
  const queued = new Map<number, () => void>();
  let next = 1;
  return {
    request: (fn) => {
      const handle = next;
      next += 1;
      queued.set(handle, fn);
      return handle;
    },
    cancel: (handle) => {
      queued.delete(handle);
    },
    pending: () => queued.size,
    run: () => {
      const due = [...queued.values()];
      queued.clear();
      for (const fn of due) fn();
    },
  };
}

/**
 * The server's runtime with its two DOM-only verbs switched on: effects run once, at once, and
 * cleanups are collected for `unmount`. Signals and memos are the inert ones — a test reading a
 * getter after a write sees the write, which is all a single pass needs.
 */
export function syncRuntime(): {
  readonly runtime: SolidRuntime;
  readonly unmount: () => void;
  /** Every memo the render created, in creation order: what a server-factory attribute froze. */
  readonly memos: readonly (() => unknown)[];
  /** Every signal's reader, in creation order. */
  readonly signals: readonly (() => unknown)[];
} {
  const cleanups: (() => void)[] = [];
  const memos: (() => unknown)[] = [];
  const signals: (() => unknown)[] = [];
  const runtime: SolidRuntime = {
    ...INERT_SOLID_RUNTIME,
    createSignal: <T>(value: T) => {
      const pair = INERT_SOLID_RUNTIME.createSignal(value);
      signals.push(pair[0]);
      return pair;
    },
    createMemo: <T>(fn: () => T) => {
      memos.push(fn);
      return fn;
    },
    createEffect: (fn: () => void): void => fn(),
    onCleanup: (fn: () => void): void => {
      cleanups.push(fn);
    },
  };
  return {
    runtime,
    memos,
    signals,
    unmount: () => {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}

export type Solid = typeof import('solid-js');

/** Solid's BROWSER build — the one an island runs — never the server build `bun` resolves. */
export async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

/** The seven functions the adapter takes, picked off a real Solid. */
export function runtimeOf(solid: Solid): SolidRuntime {
  const {
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  } = solid;
  return {
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  };
}
