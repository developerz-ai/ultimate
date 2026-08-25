// The emitted hydration runtime, EXECUTED — split from `hydrate.test.ts` for the reason
// `island-budget.test.ts` split from `modes.test.ts`: that file pins the emitted STRING, and a
// string assertion cannot see a promise resolve in the wrong order or a marker land too early.
// Every test here runs the real runtime text against a hand-built document.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hydrateRuntime, type IslandDirective } from './hydrate';

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'idle',
  entry: '/chunks/x1.js',
  ...overrides,
});

// The replay contract is a promise ordering inside the runtime, and a string assertion cannot see
// an early flush. Driven by a deferred mount rather than by a timer: the failure is "the queue
// flushed before the chunk mounted", which is an ordering fact, and a wall-clock assertion would
// only be a slower guess.
describe('the interaction runtime, executed', () => {
  interface Harness {
    /** Fire one replayable event at the island, as a real listener would receive it. */
    readonly fire: (type: string) => void;
    /** Event types the runtime re-dispatched onto the target. */
    readonly replayed: readonly string[];
    /** Let the island's `mount` finish. */
    readonly finishMount: () => void;
    /** Reject the island's `mount`, the way a chunk with a broken import does. */
    readonly failMount: (message: string) => void;
    readonly mounts: () => number;
    /** Event types the element is still listening for. */
    readonly attached: () => readonly string[];
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
    let failMount = (_message: string): void => undefined;
    const gate = new Promise<void>((resolve, reject) => {
      finishMount = resolve;
      failMount = (message) => {
        reject(new TypeError(message));
      };
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
      // Every real element has one, and `boot` marks the mount outcome through it.
      setAttribute: (): void => undefined,
      // This element is both the island root and every event's target, and it has no children — so
      // containment reduces to identity here. `hydrate-replay.test.ts` is where the two are
      // different nodes, which is the case this harness cannot express and the defect it hid.
      contains: (node: unknown): boolean => node === element,
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
      failMount,
      mounts: () => mounts,
      attached: () => [...listeners].filter(([, fns]) => fns.length > 0).map(([name]) => name),
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

  // `boot` rethrows on purpose, so `el.__x` is a REJECTED promise from the first failed mount
  // onward. Nothing here calls `settled()` — this suite has no `__x` to await and Bun's runner
  // fails a test on an unhandled rejection, so a `.then` with no rejection arm reds this test by
  // itself, which is the whole point: in a browser that is one console rejection per user event.
  test('a mount that throws detaches its listeners instead of queueing forever', async () => {
    const harness = await bootInteractionRuntime();
    try {
      harness.fire('click');
      await settle();
      expect(harness.attached()).toEqual(['click']);

      harness.failMount('mount is not a function');
      await settle();

      // The island is dead: nothing is replayed into it, and it stops holding the events.
      expect(harness.replayed).toEqual([]);
      expect(harness.attached()).toEqual([]);

      // A later click reaches nothing here — the retained `Event` objects, each with a live
      // `target`, were the growing half of the leak.
      harness.fire('click');
      await settle();
      expect(harness.replayed).toEqual([]);
      expect(harness.mounts()).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

// The mount markers, EXECUTED. `el.__x` is assigned when `import()` is CALLED, so "declared",
// "importing" and "running" were three facts with two observables between them — and the missing
// one is the half that gates: a picture cannot say whether the island threw. Driven by a deferred
// mount, because the whole claim is about which of the three states the DOM is in at each moment.
describe('the mount markers, executed', () => {
  interface FakeElement {
    /** The boot promise the runtime assigns. Present from the `import()`, not from the mount. */
    __x?: Promise<unknown>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  }

  interface MountHarness {
    readonly attribute: (name: string) => string | null;
    readonly booting: () => boolean;
    /** Let the island's `mount` resolve, or reject it with this message. */
    readonly finishMount: () => void;
    readonly failMount: (message: string) => void;
    /** Settled boot promise, awaited so a rejection is never an unhandled one. */
    readonly settled: () => Promise<void>;
    readonly dispose: () => Promise<void>;
  }

  /** Microtasks plus one real timer: the idle fallback path is `setTimeout(go,1)`. */
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  };

  /** Bounded and non-throwing — a boot that never happens must fail an assertion, not hang. */
  const waitFor = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !ready(); i += 1) await tick();
  };

  async function bootIdleRuntime(): Promise<MountHarness> {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-mount-marker-'));
    const globals = globalThis as unknown as Record<string, unknown>;

    let mounting = false;
    let finishMount = (): void => undefined;
    let failMount = (_message: string): void => undefined;
    const gate = new Promise<void>((resolve, reject) => {
      finishMount = resolve;
      failMount = (message) => {
        reject(new TypeError(message));
      };
    });
    globals['__xTestMount'] = (): Promise<void> => {
      mounting = true;
      return gate;
    };

    const island = join(dir, 'island.mjs');
    await writeFile(island, 'export function mount(){return globalThis.__xTestMount()}\n', 'utf8');

    // A Map, not a record: `getAttribute('toString')` off an object walks the prototype chain and
    // hands the runtime a function, which is the trap `render/CLAUDE.md` names for real elements.
    const attributes = new Map<string, string>([['data-x-entry', pathToFileURL(island).href]]);
    const element: FakeElement = {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
    };
    globals['document'] = {
      querySelectorAll: (selector: string): unknown[] =>
        selector.includes('idle') ? [element] : [],
      // No props script: the island takes none, so `boot` must still reach the import.
      querySelector: (): unknown => null,
    };
    // Empty, so `'requestIdleCallback' in window` is false and the runtime takes its own fallback.
    globals['window'] = {};

    const runtime = join(dir, 'runtime.mjs');
    const source = hydrateRuntime([directive({ strategy: 'idle' })])
      .replace('<script type="module">', '')
      .replace('</script>', '');
    await writeFile(runtime, source, 'utf8');
    await import(pathToFileURL(runtime).href);
    await waitFor(() => mounting);

    return {
      attribute: (name) => attributes.get(name) ?? null,
      booting: () => element.__x !== undefined,
      finishMount,
      failMount,
      settled: async () => {
        await element.__x?.then(
          () => undefined,
          () => undefined,
        );
        await tick();
      },
      dispose: async () => {
        globals['document'] = undefined;
        globals['window'] = undefined;
        globals['__xTestMount'] = undefined;
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  test('a mount that REJECTS is marked failed, and never marked mounted', async () => {
    const harness = await bootIdleRuntime();
    try {
      harness.failMount('mount is not a function');
      await harness.settled();

      expect(harness.attribute('data-x-mounted')).toBeNull();
      expect(harness.attribute('data-x-failed')).toBe('mount is not a function');
    } finally {
      await harness.dispose();
    }
  });

  test('while the chunk is still mounting, neither marker is set — but boot has started', async () => {
    const harness = await bootIdleRuntime();
    try {
      await tick();

      // The three facts, told apart: the boot promise exists, and neither outcome has landed.
      expect(harness.booting()).toBe(true);
      expect(harness.attribute('data-x-mounted')).toBeNull();
      expect(harness.attribute('data-x-failed')).toBeNull();

      harness.finishMount();
      await harness.settled();
      expect(harness.attribute('data-x-mounted')).toBe('');
    } finally {
      await harness.dispose();
    }
  });

  test('a mount that RESOLVES is marked mounted, and not failed', async () => {
    const harness = await bootIdleRuntime();
    try {
      harness.finishMount();
      await harness.settled();

      expect(harness.attribute('data-x-mounted')).toBe('');
      expect(harness.attribute('data-x-failed')).toBeNull();
    } finally {
      await harness.dispose();
    }
  });

  test('a failure with no message is still marked, so absence never means "fine"', async () => {
    const harness = await bootIdleRuntime();
    try {
      harness.failMount('');
      await harness.settled();

      expect(harness.attribute('data-x-failed')).toBe('1');
      expect(harness.attribute('data-x-mounted')).toBeNull();
    } finally {
      await harness.dispose();
    }
  });

  // `settled()` is deliberately NOT called: it attaches a rejection handler of its own, which is
  // exactly what the runtime was missing. Bun's runner fails a test on an unhandled rejection, so
  // a bare `boot(el)` in the idle block reds this test by itself.
  test('a failed mount leaves no unhandled rejection behind', async () => {
    const harness = await bootIdleRuntime();
    try {
      harness.failMount('mount is not a function');
      await tick();
      // The failure is not swallowed, only terminated: the DOM still carries it.
      expect(harness.attribute('data-x-failed')).toBe('mount is not a function');
    } finally {
      await harness.dispose();
    }
  });
});

// The same rule for `visible`, which reaches `boot` from an IntersectionObserver callback — a
// stack with no caller left to hand a rejection to.
describe('the visible runtime, executed', () => {
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  };

  test('an island that fails to mount is marked failed and rejects nothing globally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-visible-'));
    const globals = globalThis as unknown as Record<string, unknown>;
    let failMount = (_message: string): void => undefined;
    const gate = new Promise<void>((_resolve, reject) => {
      failMount = (message) => {
        reject(new TypeError(message));
      };
    });
    globals['__xTestMount'] = (): Promise<void> => gate;

    const island = join(dir, 'island.mjs');
    await writeFile(island, 'export function mount(){return globalThis.__xTestMount()}\n', 'utf8');

    const attributes = new Map<string, string>([['data-x-entry', pathToFileURL(island).href]]);
    const element = {
      getAttribute: (name: string): string | null => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string): void => {
        attributes.set(name, value);
      },
    };
    globals['document'] = {
      querySelectorAll: (selector: string): unknown[] =>
        selector.includes('visible') ? [element] : [],
      querySelector: (): unknown => null,
    };
    // Fires immediately, which is what a viewport-visible island does on first paint.
    globals['IntersectionObserver'] = class {
      readonly #callback: (entries: readonly { isIntersecting: boolean }[]) => void;
      constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) {
        this.#callback = callback;
      }
      observe(): void {
        this.#callback([{ isIntersecting: true }]);
      }
      disconnect(): void {
        // The runtime disconnects before it boots; nothing here has to observe that.
      }
    };

    try {
      const runtime = join(dir, 'runtime.mjs');
      const source = hydrateRuntime([directive({ strategy: 'visible' })])
        .replace('<script type="module">', '')
        .replace('</script>', '');
      await writeFile(runtime, source, 'utf8');
      await import(pathToFileURL(runtime).href);

      failMount('mount is not a function');
      await tick();

      expect(attributes.get('data-x-failed')).toBe('mount is not a function');
      expect(attributes.has('data-x-mounted')).toBe(false);
    } finally {
      globals['document'] = undefined;
      globals['IntersectionObserver'] = undefined;
      globals['__xTestMount'] = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
