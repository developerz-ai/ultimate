// One responsibility: ONE browser shared by the suites of a test process that ask for it by the
// same key — opened by the first, a holder count per suite, closed by the last out or at the run's
// end. Opening and closing a browser is `cdp-browser.ts`; this file only decides WHEN.

import { afterAll } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_OPEN_MS } from './cdp-browser';

export interface E2eBrowserLease {
  /** The shared browser: opened by the first lease of its key, `undefined` with no browser here. */
  readonly opened: Promise<E2eBrowser | undefined>;
  /** This holder is done. Idempotent. The last one out closes it, unless the run closes it at its end. */
  release(): Promise<void>;
}

/** Registers a hook for the end of the run — a preload's `afterAll`, which Bun runs once, last. */
export type RunEndHook = (hook: () => Promise<void>, timeoutMs: number) => void;

export interface E2eBrowserLeases {
  lease(key: string, open: () => Promise<E2eBrowser | undefined>): E2eBrowserLease;
  /** From a PRELOAD: keep every leased browser open until the run ends, then close each. */
  closeAtRunEnd(after: RunEndHook): void;
}

interface Held {
  readonly opening: Promise<E2eBrowser | undefined>;
  holders: number;
}

/** Its open already failed in front of the holder that awaited it: the close has nothing to add. */
const closeHeld = async (held: Held): Promise<void> => {
  const browser = await held.opening.catch(() => undefined);
  await browser?.close();
};

/**
 * A fresh registry. Why the last holder alone cannot make "last" mean the last SUITE: Bun runs one
 * test file to its end before it loads the next (measured on 1.4.2), so between two suites the
 * count is 0; and `exit` and `beforeExit` never fire under `bun test`, so a browser kept "for the
 * next one" past the last file is a Chrome and a profile left behind. Only a preload's `afterAll`
 * runs after every file — under `--isolate` after each, with a fresh global, which is right too.
 */
export function createE2eBrowserLeases(): E2eBrowserLeases {
  const held = new Map<string, Held>();
  let runEnd = false;
  return {
    lease(key, open) {
      let shared = held.get(key);
      if (shared === undefined) {
        const made: Held = { opening: open(), holders: 0 };
        held.set(key, made);
        // A failed open is nobody's to share: the next holder opens afresh and meets its own error.
        made.opening.catch(() => {
          if (held.get(key) === made) held.delete(key);
        });
        shared = made;
      }
      const mine = shared;
      mine.holders += 1;
      let released = false;
      return {
        opened: mine.opening,
        async release() {
          if (released) return;
          released = true;
          mine.holders -= 1;
          if (mine.holders > 0 || runEnd) return;
          if (held.get(key) === mine) held.delete(key);
          await closeHeld(mine);
        },
      };
    },
    closeAtRunEnd(after) {
      if (runEnd) return;
      runEnd = true;
      // The deadline of an open: the hook awaits one still in flight before it can close it.
      after(async () => {
        const open = [...held.values()];
        held.clear();
        for (const one of open) await closeHeld(one);
      }, E2E_BROWSER_OPEN_MS);
    },
  };
}

/**
 * On `globalThis` under one `Symbol.for` key: the preload imports this module by path and a suite
 * through `@ultimat3/testing`, and each may hold its own copy — `e2e-browser-handle.ts`'s reason.
 */
const KEY = Symbol.for('ultimate.e2e.browserLeases');

const processLeases = (): E2eBrowserLeases => {
  const known = Reflect.get(globalThis, KEY) as E2eBrowserLeases | undefined;
  if (known !== undefined) return known;
  const made = createE2eBrowserLeases();
  Object.defineProperty(globalThis, KEY, { value: made, configurable: true });
  return made;
};

/**
 * The browser the suites of this process share under `key`; call it in a `beforeAll` and
 * `release()` in the matching `afterAll`. Without `closeE2eBrowsersAtRunEnd` in the preload the
 * last holder out closes it, which is one browser per suite again — never one left running.
 */
export const leaseE2eBrowser = (
  key: string,
  open: () => Promise<E2eBrowser | undefined>,
): E2eBrowserLease => processLeases().lease(key, open);

/** The preload's half: `closeE2eBrowsersAtRunEnd()` once, and leased browsers live for the run. */
export const closeE2eBrowsersAtRunEnd = (after: RunEndHook = afterAll): void =>
  processLeases().closeAtRunEnd(after);
