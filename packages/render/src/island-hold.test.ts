// The held island (#506), as markup and EXECUTED: server markup that must not paint before the
// island mounts is hidden from its first byte, booted at once whatever the route's strategy, and
// revealed when the mount settles — or at the cap, whatever the chunk does.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway tree.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { IslandDirective } from './hydrate';
import { emitIslandAttributes, HYDRATE_RUNTIME_BODIES, hydrateRuntime } from './hydrate';
import type { IslandSpec } from './island';
import { islandCollector } from './island-collector';
import { ISLAND_HOLD_ATTRIBUTE, ISLAND_HOLD_MS } from './island-hold';

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'idle',
  entry: '/chunks/x1.js',
  ...overrides,
});

const body = (directives: readonly IslandDirective[]): string =>
  hydrateRuntime(directives)
    .replace(/^<script type="module">/, '')
    .replace(/<\/script>$/, '');

describe('a held island, as markup', () => {
  test('is hidden from its first byte, by an attribute the runtime finds it by', () => {
    const attrs = emitIslandAttributes(directive({ hold: true }));
    expect(attrs).toContain(`${ISLAND_HOLD_ATTRIBUTE} style="visibility:hidden;`);
  });

  test('an island that is not held carries neither', () => {
    const attrs = emitIslandAttributes(directive());
    expect(attrs).not.toContain(ISLAND_HOLD_ATTRIBUTE);
    expect(attrs).not.toContain('style=');
  });

  test('a `never` island is inert, so it is never held — nothing would ever reveal it', () => {
    expect(emitIslandAttributes(directive({ strategy: 'never', hold: true }))).not.toContain(
      ISLAND_HOLD_ATTRIBUTE,
    );
  });

  test('the collector holds exactly the islands its `hold` answers for', () => {
    const spec = (moduleId: string): IslandSpec => ({
      moduleId,
      src: `./${moduleId}.island.tsx`,
      propKeys: [],
      tag: 'div',
    });
    const collector = islandCollector({
      file: 'app/x/page.tsx',
      hydrate: 'idle',
      hold: (src) => src === './live.island.tsx',
    });
    collector.record(spec('live'), {});
    collector.record(spec('still'), {});
    expect(collector.directives.map((d) => d.hold === true)).toEqual([true, false]);
  });

  test('only a page with a held island pays for the hold runtime', () => {
    expect(body([directive()])).not.toContain(ISLAND_HOLD_ATTRIBUTE);
    expect(body([directive({ hold: true })])).toContain(ISLAND_HOLD_ATTRIBUTE);
  });

  test('every held body is enumerated for the CSP, and no other', () => {
    const strategies = ['idle', 'visible', 'interaction'] as const;
    const emitted = new Set<string>();
    for (let mask = 1; mask < 2 ** strategies.length; mask += 1) {
      const chosen = strategies.filter((_s, bit) => ((mask >> bit) & 1) === 1);
      for (const hold of [false, true]) {
        emitted.add(body(chosen.map((strategy) => directive({ strategy, hold }))));
      }
    }
    expect(new Set(HYDRATE_RUNTIME_BODIES)).toEqual(emitted);
  });
});

describe('held islands, executed', () => {
  interface Held {
    __x?: Promise<unknown>;
    readonly attributes: Map<string, string>;
    readonly visibility: () => string;
    readonly finishMount: () => void;
    readonly failMount: () => void;
  }

  const globals = globalThis as unknown as Record<string, unknown>;
  const realSetTimeout = globalThis.setTimeout;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    globalThis.setTimeout = realSetTimeout;
    await cleanup?.();
    cleanup = undefined;
  });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => {
      realSetTimeout(resolve, 0);
    });
  };

  const hidden = (el: Held): boolean =>
    el.attributes.has(ISLAND_HOLD_ATTRIBUTE) && el.visibility() === 'hidden';
  const shown = (el: Held): boolean =>
    !el.attributes.has(ISLAND_HOLD_ATTRIBUTE) && el.visibility() === '';

  /** One held island root, whose `mount` the test settles by hand. */
  function heldElement(entry: string): Held {
    let finishMount = (): void => undefined;
    let failMount = (): void => undefined;
    const gate = new Promise<void>((resolve, reject) => {
      finishMount = resolve;
      failMount = () => reject(new TypeError('the chunk would not load'));
    });
    const styles = new Map<string, string>([['visibility', 'hidden']]);
    const attributes = new Map<string, string>([
      ['data-x-entry', entry],
      [ISLAND_HOLD_ATTRIBUTE, ''],
    ]);
    return {
      attributes,
      visibility: () => styles.get('visibility') ?? '',
      finishMount,
      failMount,
      gate,
      getAttribute: (name: string): string | null => attributes.get(name) ?? null,
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
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    } as Held;
  }

  /**
   * Runs the real runtime over `count` held `interaction` islands — the strategy that would
   * otherwise never boot without a press, which a hidden island cannot receive. The cap's timer is
   * captured rather than waited for, so the test asks what it does, not how long it takes.
   */
  async function run(count = 1): Promise<{
    readonly els: readonly Held[];
    readonly mounts: () => number;
    readonly fireCap: () => void;
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-hold-'));
    const chunk = join(dir, 'island.mjs');
    await writeFile(
      chunk,
      'export function mount(el){return globalThis.__xTestMount(el)}\n',
      'utf8',
    );
    const els = Array.from({ length: count }, (_u, i) =>
      heldElement(`${Bun.pathToFileURL(chunk).href}?i=${i}`),
    );
    let mounts = 0;
    globals['__xTestMount'] = (el: { gate: Promise<void> }): Promise<void> => {
      mounts += 1;
      return el.gate;
    };
    globals['document'] = {
      querySelectorAll: (selector: string): unknown[] =>
        selector.includes('interaction') || selector.includes(ISLAND_HOLD_ATTRIBUTE) ? els : [],
      querySelector: (): unknown => null,
    };
    let cap: (() => void) | undefined;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === ISLAND_HOLD_MS) {
        cap = fn;
        return 0;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;

    const runtime = join(dir, 'runtime.mjs');
    await writeFile(runtime, body([directive({ strategy: 'interaction', hold: true })]), 'utf8');
    await import(Bun.pathToFileURL(runtime).href);
    cleanup = async () => {
      for (const el of els) await el.__x?.catch(() => undefined);
      globals['document'] = undefined;
      globals['__xTestMount'] = undefined;
      await rm(dir, { recursive: true, force: true });
    };
    return {
      els,
      mounts: () => mounts,
      fireCap: () => {
        if (cap === undefined) return expect.unreachable('the runtime armed no hold cap');
        cap();
      },
    };
  }

  test('boots at once, stays hidden while it mounts, and is revealed by the mount', async () => {
    const { els, mounts } = await run();
    const [el] = els;
    if (el === undefined) return expect.unreachable('no island');
    await settle();
    expect(mounts()).toBe(1);
    expect(hidden(el)).toBe(true);
    el.finishMount();
    await settle();
    expect(shown(el)).toBe(true);
  });

  // One record, many places (#506): a reader island that mounts first must not show the record
  // before the writer island beside it has rebuilt the queued overlay during ITS mount.
  test('held islands are revealed together, once the last of them has mounted', async () => {
    const { els, mounts } = await run(2);
    const [reader, writer] = els;
    if (reader === undefined || writer === undefined) return expect.unreachable('two islands');
    await settle();
    expect(mounts()).toBe(2);
    reader.finishMount();
    await settle();
    expect([hidden(reader), hidden(writer)]).toEqual([true, true]);
    writer.finishMount();
    await settle();
    expect([shown(reader), shown(writer)]).toEqual([true, true]);
  });

  test('a mount that fails reveals the server markup rather than hiding it forever', async () => {
    const { els } = await run(2);
    const [failed, fine] = els;
    if (failed === undefined || fine === undefined) return expect.unreachable('two islands');
    await settle();
    failed.failMount();
    fine.finishMount();
    await settle();
    expect([shown(failed), shown(fine)]).toEqual([true, true]);
  });

  test('a mount that never settles is revealed at the cap, with every other', async () => {
    const { els, fireCap } = await run(2);
    const [stuck, fine] = els;
    if (stuck === undefined || fine === undefined) return expect.unreachable('two islands');
    await settle();
    fine.finishMount();
    await settle();
    expect([hidden(stuck), hidden(fine)]).toEqual([true, true]);
    fireCap();
    expect([shown(stuck), shown(fine)]).toEqual([true, true]);
    stuck.finishMount();
  });
});
