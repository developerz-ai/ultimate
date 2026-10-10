// A held island against the strategy's own machinery, EXECUTED with real listeners (#506 audit):
// the hold boots the island itself, so the strategy's capture listeners must still let go — a
// click after the reveal is the island's own, never replayed into it a second time. Also: the hold
// runs before any strategy part can throw, and its cap timer goes once the island is shown.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway tree.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HydrateStrategy } from '@ultimat3/core';
import { emitIslandAttributes, hydrateRuntime, type IslandDirective } from './hydrate';
import { ISLAND_HOLD_ATTRIBUTE, ISLAND_HOLD_MS, ISLAND_HOLD_REVEAL } from './island-hold';

const globals = globalThis as unknown as Record<string, unknown>;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  await cleanup?.();
  cleanup = undefined;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => {
    realSetTimeout(resolve, 0);
  });
};

class FakeEvent {
  readonly type: string;
  readonly target: unknown;
  constructor(type: string, init: { target: unknown }) {
    this.type = type;
    this.target = init.target;
  }
}

interface Harness {
  /** A press as the browser delivers it: every capture listener on the root sees it. */
  readonly click: () => void;
  /** Events the runtime RE-dispatched — a press that reached the island twice. */
  readonly replayed: readonly string[];
  readonly listening: () => number;
  readonly shown: () => boolean;
  readonly finishMount: () => void;
  /** Timer ids `clearTimeout` was handed, and the one the hold's cap was armed under. */
  readonly cleared: readonly unknown[];
  readonly cap: unknown;
}

/**
 * One held island under `strategy`, the real runtime over it. `requestIdleCallback` is present and
 * never fires, so an `idle` island is booted by the hold alone — the race the audit found.
 */
async function held(strategy: Exclude<HydrateStrategy, 'never'>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-hold-replay-'));
  const chunk = join(dir, 'island.mjs');
  await writeFile(chunk, 'export function mount(){return globalThis.__xTestMount()}\n', 'utf8');
  let finishMount = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    finishMount = resolve;
  });
  globals['__xTestMount'] = (): Promise<void> => gate;

  const attributes = new Map<string, string>([
    ['data-x-entry', pathToFileURL(chunk).href],
    ['data-x-hydrate', strategy],
    [ISLAND_HOLD_ATTRIBUTE, ''],
  ]);
  const styles = new Map<string, string>([
    ['visibility', 'hidden'],
    ['animation', 'x'],
  ]);
  const listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  const replayed: string[] = [];
  const el = {
    getAttribute: (name: string): string | null => attributes.get(name) ?? null,
    hasAttribute: (name: string): boolean => attributes.has(name),
    setAttribute: (name: string, value: string): void => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string): void => {
      attributes.delete(name);
    },
    style: {
      removeProperty: (name: string): void => {
        styles.delete(name);
      },
    },
    contains: (node: unknown): boolean => node === el,
    children: [],
    addEventListener: (name: string, fn: (event: FakeEvent) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    removeEventListener: (name: string, fn: (event: FakeEvent) => void): void => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((one) => one !== fn),
      );
    },
    dispatchEvent: (event: FakeEvent): boolean => {
      replayed.push(event.type);
      return true;
    },
  };
  globals['document'] = {
    querySelectorAll: (selector: string): unknown[] =>
      selector.includes(strategy) || selector.includes(ISLAND_HOLD_ATTRIBUTE) ? [el] : [],
    querySelector: (): unknown => null,
  };
  globals['window'] = { requestIdleCallback: () => 0 };
  globals['requestIdleCallback'] = () => 0;
  const cleared: unknown[] = [];
  const CAP = Symbol('cap');
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    ms === ISLAND_HOLD_MS ? CAP : realSetTimeout(fn, ms)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    cleared.push(id);
  }) as typeof clearTimeout;

  const runtime = join(dir, 'runtime.mjs');
  const directive: IslandDirective = { islandId: 'x1', strategy, entry: '/x.js', hold: true };
  const source = hydrateRuntime([directive])
    .replace('<script type="module">', '')
    .replace('</script>', '');
  await writeFile(runtime, source, 'utf8');
  try {
    await import(pathToFileURL(runtime).href);
  } catch {
    // A strategy part that throws (Bun has no IntersectionObserver) — what the hold must survive.
  }
  cleanup = async () => {
    globals['document'] = undefined;
    globals['window'] = undefined;
    globals['requestIdleCallback'] = undefined;
    globals['__xTestMount'] = undefined;
    await rm(dir, { recursive: true, force: true });
  };
  return {
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn(new FakeEvent('click', { target: el }));
    },
    replayed,
    listening: () => [...listeners.values()].reduce((n, fns) => n + fns.length, 0),
    shown: () => !attributes.has(ISLAND_HOLD_ATTRIBUTE) && styles.size === 0,
    finishMount,
    cleared,
    cap: CAP,
  };
}

describe('a held island, after its reveal', () => {
  for (const strategy of ['interaction', 'idle'] as const) {
    test(`${strategy}: one click reaches the island once, never replayed into it`, async () => {
      const island = await held(strategy);
      island.finishMount();
      await settle();
      expect(island.shown()).toBe(true);
      island.click();
      await settle();
      // The press went to its target natively; a re-dispatch would be the second run.
      expect(island.replayed).toEqual([]);
      expect(island.listening()).toBe(0);
    });
  }

  test('the cap timer is cleared once the island is shown', async () => {
    const island = await held('interaction');
    island.finishMount();
    await settle();
    expect(island.cleared).toContain(island.cap);
  });
});

describe('the hold runs first', () => {
  test('a strategy part that throws (no IntersectionObserver) cannot strand a held island', async () => {
    const island = await held('visible');
    island.finishMount();
    await settle();
    expect(island.shown()).toBe(true);
  });
});

describe('the reveal that needs no script', () => {
  test('the wrapper carries a CSS reveal at the cap, and the framework sheet defines it', async () => {
    const attrs = emitIslandAttributes({
      islandId: 'x1',
      strategy: 'idle',
      entry: '/x.js',
      hold: true,
    });
    expect(attrs).toContain(`animation:${ISLAND_HOLD_REVEAL} 0s ${ISLAND_HOLD_MS}ms forwards`);
    // Two packages, one name: `ui` cannot import render (sideways), so the sheet is read as text.
    const sheet = await readFile(join(import.meta.dir, '../../ui/src/global.scss'), 'utf8');
    expect(sheet).toMatch(
      new RegExp(
        `@keyframes ${ISLAND_HOLD_REVEAL}\\s*\\{\\s*to\\s*\\{\\s*visibility:\\s*visible;?\\s*\\}`,
      ),
    );
  });

  // The keyframes above still cost a no-script reader the whole cap: three seconds of an empty
  // box where the page's content is. A browser that says scripting is off never waits at all.
  test('with scripting off the framework sheet cancels the hold outright, over the inline style', async () => {
    const sheet = await readFile(join(import.meta.dir, '../../ui/src/global.scss'), 'utf8');
    const rule = new RegExp(
      `@media \\(scripting: none\\)\\s*\\{\\s*\\[${ISLAND_HOLD_ATTRIBUTE}\\]\\s*\\{([^}]*)\\}`,
    ).exec(sheet)?.[1];
    // `!important`: the hold is an inline style, and an important author rule also outranks the
    // animation that would otherwise keep the wrapper hidden until the cap.
    expect(rule).toMatch(/visibility:\s*visible\s*!important/);
    expect(rule).toMatch(/animation:\s*none\s*!important/);
  });
});
