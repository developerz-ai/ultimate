/**
 * The per-render collector: what one page pulled in, and the three ways a render is refused
 * before any markup is emitted — an unhydrated route, two modules claiming one id, and a
 * resolver whose answer cannot be written into an attribute.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { DEFAULT_REPLAY_EVENTS } from './hydrate';
import type { IslandSpec } from './island';
import { clearDeclaredIslands, island } from './island';
import { createIslandCollector, islandModuleIds } from './island-collector';
import type { JsxProps } from './jsx';

const FILE = 'apps/web/site/pricing/page.tsx';

// `'idle'` wherever the strategy is incidental: it is a real `HydrateStrategy` (the collector
// emits it verbatim into `directive.strategy`, so `'load'` — a name no strategy has carried since
// the four were fixed — was writing a value the client runtime cannot dispatch on), it is not
// `'never'` so `assertHydrates` passes, and it is not `'interaction'` so no test picks up replay
// events it did not ask for.

const specOf = (over: Partial<IslandSpec> = {}): IslandSpec => ({
  moduleId: 'cart',
  src: './cart.island.tsx',
  propKeys: [],
  tag: 'div',
  ...over,
});

const thrownBy = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  return expect.unreachable('expected an UltimateError');
};

// `island()` pushes onto a module-global list that only `defineRoute` drains, so a file that
// declares one and never defines a route would hand it to whatever runs next.
beforeEach(() => {
  clearDeclaredIslands();
});

describe('createIslandCollector · record', () => {
  test('numbers the instances per module, so two of one island get two ids and one entry', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'idle' });
    const cart = specOf();
    const first = collector.record(cart, {});
    const second = collector.record(cart, {});
    const other = collector.record(specOf({ moduleId: 'modal', src: './modal.island.tsx' }), {});

    expect([first.islandId, second.islandId, other.islandId]).toEqual([
      'cart-1',
      'cart-2',
      'modal-1',
    ]);
    expect(collector.directives).toHaveLength(3);
    expect(islandModuleIds(collector.directives)).toEqual(['cart', 'modal']);
  });

  test('the route decides the strategy — the island never carries one of its own', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'visible' });
    expect(collector.hydrate).toBe('visible');
    expect(collector.record(specOf(), {}).strategy).toBe('visible');
  });

  test('resolve() replaces the specifier with the built chunk URL', () => {
    const collector = createIslandCollector({
      file: FILE,
      hydrate: 'idle',
      resolve: (src) => `/_x/chunks${src.replace('./', '/')}`,
    });
    expect(collector.record(specOf(), {}).entry).toBe('/_x/chunks/cart.island.tsx');
    // No resolver is identity, which is what dev and the tests run on.
    const plain = createIslandCollector({ file: FILE, hydrate: 'idle' });
    expect(plain.record(specOf(), {}).entry).toBe('./cart.island.tsx');
  });

  test('an empty prop bag is omitted from the directive rather than emitted as {}', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'idle' });
    expect(Object.hasOwn(collector.record(specOf(), {}), 'props')).toBe(false);
    const withProps = collector.record(specOf({ propKeys: ['id'] }), { id: 'p1' } as JsxProps);
    expect(withProps.props).toEqual({ id: 'p1' });
  });

  test('replay events default only under interaction, and a declaration still wins', () => {
    const idle = createIslandCollector({ file: FILE, hydrate: 'idle' });
    expect(idle.record(specOf(), {}).events).toBeUndefined();

    const interaction = createIslandCollector({ file: FILE, hydrate: 'interaction' });
    expect(interaction.record(specOf(), {}).events).toEqual(DEFAULT_REPLAY_EVENTS);
    expect(interaction.record(specOf({ events: ['pointerdown'] }), {}).events).toEqual([
      'pointerdown',
    ]);
    // A declared list is kept whatever the strategy: `idle` above answered undefined, not the
    // default, so this is the declaration and not the fallback.
    expect(idle.record(specOf({ events: ['focusin'] }), {}).events).toEqual(['focusin']);
  });

  test('rootMargin travels only when declared', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'visible' });
    expect(Object.hasOwn(collector.record(specOf(), {}), 'rootMargin')).toBe(false);
    expect(collector.record(specOf({ rootMargin: '400px' }), {}).rootMargin).toBe('400px');
  });
});

describe('createIslandCollector · two modules, one id', () => {
  // The id is what the browser keys the prop bag on, so two entries under one id hand one
  // island's props to whichever chunk the browser booted first.
  test('is refused, naming both resolved entries', () => {
    const collector = createIslandCollector({
      file: FILE,
      hydrate: 'idle',
      resolve: (src) => `/_x/${src.replace('./', '')}`,
    });
    collector.record(specOf({ src: './cart.island.tsx' }), {});
    const error = thrownBy(() => collector.record(specOf({ src: './other.island.tsx' }), {}));

    expect(error.code).toBe('X_ISLAND_INVALID');
    expect(error.cause).toContain('/_x/cart.island.tsx');
    expect(error.cause).toContain('/_x/other.island.tsx');
    expect(error.fix).toContain('rename one of the modules');
    // The refused instance is not recorded, so the page is not billed for it either.
    expect(collector.directives).toHaveLength(1);
  });

  test('the same id resolving to the same entry is the ordinary two-instance case', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'idle' });
    collector.record(specOf(), {});
    expect(() => collector.record(specOf(), {})).not.toThrow();
    expect(islandModuleIds(collector.directives)).toEqual(['cart']);
  });

  test('a collector is per render — a second one does not inherit the first claim', () => {
    const resolve = (src: string) => `/_x/${src.replace('./', '')}`;
    const first = createIslandCollector({ file: FILE, hydrate: 'idle', resolve });
    first.record(specOf({ src: './cart.island.tsx' }), {});
    const second = createIslandCollector({ file: FILE, hydrate: 'idle', resolve });
    expect(() => second.record(specOf({ src: './other.island.tsx' }), {})).not.toThrow();
    expect(second.directives).toHaveLength(1);
  });
});

describe('createIslandCollector · an entry that cannot be emitted', () => {
  test.each([
    ['a quote', './cart".island.tsx'],
    ['a space', './my cart.island.tsx'],
    ['an angle bracket', './cart<script>.island.tsx'],
    ['nothing at all', ''],
  ])('%s in the resolver output is refused', (_name, resolved) => {
    const collector = createIslandCollector({
      file: FILE,
      hydrate: 'idle',
      resolve: () => resolved,
    });
    const error = thrownBy(() => collector.record(specOf(), {}));
    expect(error.code).toBe('X_ISLAND_INVALID');
    expect(error.cause).toContain(JSON.stringify(resolved));
    expect(error.fix).toContain('resolve()');
  });

  test('a plain URL path is accepted, so the check is the characters and not the shape', () => {
    const collector = createIslandCollector({
      file: FILE,
      hydrate: 'idle',
      resolve: () => '/_x/chunks/cart-9f3a.js',
    });
    expect(collector.record(specOf(), {}).entry).toBe('/_x/chunks/cart-9f3a.js');
  });
});

describe("createIslandCollector · hydrate: 'never'", () => {
  test('a drained declaration is the author writing it, and the fix is to remove it', () => {
    const collector = createIslandCollector({ file: FILE, hydrate: 'never' });
    const error = thrownBy(() => collector.record(specOf(), {}));
    expect(error.code).toBe('X_ISLAND_NOT_HYDRATED');
    expect(error.cause).toContain("the route declares hydrate: 'never'");
    expect(error.fix).toContain("remove hydrate: 'never'");
  });

  test('an undrained declaration is the island sitting below the route, and says so instead', () => {
    // `island()` leaves the spec on the pending list; nothing drained it, which is what
    // "declared where no defineRoute could see it" looks like at render time.
    const Cart = island({ src: './cart.island.tsx' });
    const pending = Cart({}).spec;
    const collector = createIslandCollector({ file: FILE, hydrate: 'never' });
    const error = thrownBy(() => collector.record(pending, {}));
    expect(error.code).toBe('X_ISLAND_NOT_HYDRATED');
    expect(error.cause).toContain('no defineRoute in that module drained');
    expect(error.fix).toContain('move the island() call');
  });
});
