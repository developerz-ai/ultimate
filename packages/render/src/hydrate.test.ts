// Pins the per-island directive → markup/runtime contract: `never` must stay inert and cost
// nothing, the other strategies must each emit exactly their own runtime block, in a fixed
// order regardless of directive order, and `hydrateRuntimeBytes` must agree with the runtime text.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPLAY_EVENTS,
  emitIslandAttributes,
  emitIslandProps,
  hydrateRuntime,
  hydrateRuntimeBytes,
  type IslandDirective,
  requiredStrategies,
} from './hydrate';

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'idle',
  entry: '/chunks/x1.js',
  ...overrides,
});

describe('emitIslandAttributes', () => {
  test('strategy "never" emits only data-x-island and data-x-hydrate', () => {
    const attrs = emitIslandAttributes(
      directive({
        strategy: 'never',
        entry: '/chunks/x1.js',
        rootMargin: '200px',
        events: ['click'],
      }),
    );
    expect(attrs).toBe('data-x-island="x1" data-x-hydrate="never"');
    expect(attrs).not.toContain('data-x-entry');
    expect(attrs).not.toContain('data-x-margin');
    expect(attrs).not.toContain('data-x-events');
  });

  test('a non-never strategy includes data-x-entry', () => {
    const attrs = emitIslandAttributes(directive({ strategy: 'idle' }));
    expect(attrs).toContain('data-x-entry="/chunks/x1.js"');
  });

  test('rootMargin is included only when set and strategy is not never', () => {
    const withMargin = emitIslandAttributes(directive({ strategy: 'visible', rootMargin: '50px' }));
    expect(withMargin).toContain('data-x-margin="50px"');

    const withoutMargin = emitIslandAttributes(directive({ strategy: 'visible' }));
    expect(withoutMargin).not.toContain('data-x-margin');
  });

  test('events is included as a space-joined attr only when non-empty', () => {
    const withEvents = emitIslandAttributes(
      directive({ strategy: 'interaction', events: ['click', 'keydown'] }),
    );
    expect(withEvents).toContain('data-x-events="click keydown"');

    const emptyEvents = emitIslandAttributes(directive({ strategy: 'interaction', events: [] }));
    expect(emptyEvents).not.toContain('data-x-events');
  });
});

describe('emitIslandProps', () => {
  test('no props produces an empty string', () => {
    expect(emitIslandProps(directive({ strategy: 'idle' }))).toBe('');
  });

  test('strategy "never" produces an empty string even with props set', () => {
    expect(emitIslandProps(directive({ strategy: 'never', props: { a: 1 } }))).toBe('');
  });

  test('otherwise renders a JSON props script tag keyed by islandId', () => {
    const html = emitIslandProps(directive({ islandId: 'x2', strategy: 'idle', props: { a: 1 } }));
    expect(html).toBe('<script type="application/json" data-x-props="x2">{"a":1}</script>');
  });

  test('a "<" inside a prop value is escaped to \\u003c, not left raw', () => {
    const html = emitIslandProps(directive({ strategy: 'idle', props: { html: '<script>' } }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('\\u003cscript\\u003e');
  });

  test('a closing tag in a prop value cannot end the props script', () => {
    const props = { html: '</script><img src=x onerror=alert(1)>' };
    const html = emitIslandProps(directive({ strategy: 'idle', props }));
    expect(html).not.toContain('<img');
    expect(html.split('</script>').length - 1).toBe(1);
    const body = /data-x-props="[^"]*">([\s\S]*)<\/script>$/.exec(html)?.[1] ?? '';
    expect(JSON.parse(body)).toEqual(props);
  });
});

describe('requiredStrategies', () => {
  test('returns the distinct non-never strategies present', () => {
    const set = requiredStrategies([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'idle' }),
    ]);
    expect(set).toEqual(new Set(['idle', 'visible']));
  });

  test('never directives contribute nothing', () => {
    const set = requiredStrategies([directive({ strategy: 'never' })]);
    expect(set).toEqual(new Set());
  });

  test('empty input produces an empty set', () => {
    expect(requiredStrategies([])).toEqual(new Set());
  });
});

describe('hydrateRuntime', () => {
  test('empty directives produce the empty string', () => {
    expect(hydrateRuntime([])).toBe('');
  });

  test('all-never directives produce the empty string', () => {
    expect(hydrateRuntime([directive({ strategy: 'never' })])).toBe('');
  });

  test('only "idle" requested emits the idle block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'idle' })]);
    expect(html).toContain('data-x-hydrate="idle"');
    expect(html).toContain('requestIdleCallback');
    expect(html).not.toContain('IntersectionObserver');
    expect(html).not.toContain('data-x-hydrate="interaction"');
  });

  test('only "visible" requested emits the visible block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'visible' })]);
    expect(html).toContain('data-x-hydrate="visible"');
    expect(html).toContain('IntersectionObserver');
    expect(html).not.toContain('requestIdleCallback');
    expect(html).not.toContain('data-x-hydrate="interaction"');
  });

  test('only "interaction" requested emits the interaction block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'interaction' })]);
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html).not.toContain('requestIdleCallback');
    expect(html).not.toContain('IntersectionObserver');
  });

  test('all three strategies present emit all three markers wrapped in one module script', () => {
    const html = hydrateRuntime([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'interaction' }),
    ]);
    expect(html).toContain('requestIdleCallback');
    expect(html).toContain('IntersectionObserver');
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html.startsWith('<script type="module">')).toBe(true);
    expect(html.endsWith('</script>')).toBe(true);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  test('output order is idle, visible, interaction regardless of input order', () => {
    const inOrder = hydrateRuntime([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'interaction' }),
    ]);
    const scrambled = hydrateRuntime([
      directive({ strategy: 'interaction' }),
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
    ]);
    expect(scrambled).toBe(inOrder);

    const idleAt = scrambled.indexOf('requestIdleCallback');
    const visibleAt = scrambled.indexOf('IntersectionObserver');
    const interactionAt = scrambled.indexOf('data-x-hydrate="interaction"');
    expect(idleAt).toBeGreaterThan(-1);
    expect(visibleAt).toBeGreaterThan(idleAt);
    expect(interactionAt).toBeGreaterThan(visibleAt);
  });
});

describe('hydrateRuntimeBytes', () => {
  test('is 0 for directives that emit no runtime', () => {
    expect(hydrateRuntimeBytes([])).toBe(0);
    expect(hydrateRuntimeBytes([directive({ strategy: 'never' })])).toBe(0);
  });

  test("agrees with TextEncoder over hydrateRuntime's own output", () => {
    const directives = [
      directive({ strategy: 'idle' }),
      directive({ strategy: 'interaction', events: ['click'] }),
    ];
    const expected = new TextEncoder().encode(hydrateRuntime(directives)).byteLength;
    expect(hydrateRuntimeBytes(directives)).toBe(expected);
  });
});

describe('DEFAULT_REPLAY_EVENTS', () => {
  test('is the exact default replay event list', () => {
    expect(DEFAULT_REPLAY_EVENTS).toEqual(['click', 'input', 'change', 'submit', 'keydown']);
  });
});

// The emitted runtime, EXECUTED. Everything above pins the STRING; the replay contract is a
// promise ordering inside it, and a string assertion cannot see an early flush. Driven by a
// deferred mount rather than by a timer: the failure is "the queue flushed before the chunk
// mounted", which is an ordering fact, and a wall-clock assertion would only be a slower guess.
describe('the interaction runtime, executed', () => {
  interface Harness {
    /** Fire one replayable event at the island, as a real listener would receive it. */
    readonly fire: (type: string) => void;
    /** Event types the runtime re-dispatched onto the target. */
    readonly replayed: readonly string[];
    /** Let the island's `mount` finish. */
    readonly finishMount: () => void;
    readonly mounts: () => number;
    readonly dispose: () => Promise<void>;
  }

  /** One turn of the loop, so a promise chain that WOULD have flushed has flushed. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  async function bootInteractionRuntime(): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-hydrate-'));
    const globals = globalThis as unknown as Record<string, unknown>;

    let mounts = 0;
    let finishMount = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      finishMount = resolve;
    });
    globals['__xTestMount'] = (): Promise<void> => {
      mounts += 1;
      return gate;
    };

    const island = join(dir, 'island.mjs');
    await writeFile(island, 'export function mount(){return globalThis.__xTestMount()}\n', 'utf8');

    const replayed: string[] = [];
    class FakeEvent {
      readonly type: string;
      readonly target: unknown;
      constructor(type: string, init: { target: unknown }) {
        this.type = type;
        this.target = init.target;
      }
    }
    const listeners = new Map<string, ((event: FakeEvent) => void)[]>();
    const element = {
      getAttribute: (name: string): string | null =>
        name === 'data-x-entry' ? pathToFileURL(island).href : null,
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
        selector.includes('interaction') ? [element] : [],
      // No props script: the island takes none, so `boot` must still reach the import.
      querySelector: (): unknown => null,
    };

    const runtime = join(dir, 'runtime.mjs');
    const source = hydrateRuntime([directive({ strategy: 'interaction', events: ['click'] })])
      .replace('<script type="module">', '')
      .replace('</script>', '');
    await writeFile(runtime, source, 'utf8');
    await import(pathToFileURL(runtime).href);

    return {
      fire: (type) => {
        for (const fn of listeners.get(type) ?? []) fn(new FakeEvent(type, { target: element }));
      },
      replayed,
      finishMount,
      mounts: () => mounts,
      dispose: async () => {
        globals['document'] = undefined;
        globals['__xTestMount'] = undefined;
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  // The bug: `boot` set `el.__x = 1` and returned a RESOLVED promise to every later caller, so a
  // second click while the chunk was still loading flushed the queue into an island that did not
  // exist yet — the events were re-dispatched at nothing and the listeners were already gone.
  test('a second interaction before the chunk mounts does not flush the queue', async () => {
    const harness = await bootInteractionRuntime();
    try {
      harness.fire('click');
      harness.fire('click');
      await settle();

      expect(harness.replayed).toEqual([]);

      harness.finishMount();
      await settle();

      expect(harness.mounts()).toBe(1);
      expect(harness.replayed).toEqual(['click', 'click']);
    } finally {
      await harness.dispose();
    }
  });

  test('one interaction still replays once the chunk mounts', async () => {
    const harness = await bootInteractionRuntime();
    try {
      harness.fire('click');
      await settle();
      expect(harness.replayed).toEqual([]);

      harness.finishMount();
      await settle();
      expect(harness.replayed).toEqual(['click']);

      // Listeners are removed once drained, so a click after the mount is the island's own.
      harness.fire('click');
      await settle();
      expect(harness.replayed).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });
});
