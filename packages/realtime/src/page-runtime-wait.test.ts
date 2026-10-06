// What a realtime island awaits before its first hook: the runtime the page boot installs where
// the document carries one, the runtime chunk where it does not — never both, never neither.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetPage } from './hooks-fixture';
import { installPageRuntime } from './page-runtime';
import { awaitPageRuntime } from './page-runtime-wait';
import { peekPageRealtime } from './page-store';

const BOOT = '/_x/page-boot/';
const host = globalThis as { document?: unknown };

afterEach(() => {
  delete host.document;
  resetPage();
});

/** A `<script>` the test fires: `load` once the boot ran, `error` once it failed to arrive. */
class FakeScript {
  readonly #listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

/** A document still parsing, whose only page boot is `script`. */
function parsingWith(script: FakeScript | null): { asked: string[] } {
  const asked: string[] = [];
  host.document = {
    readyState: 'interactive',
    querySelector: (selector: string) => {
      asked.push(selector);
      return script;
    },
  };
  return { asked };
}

/** The runtime chunk, as the island's `import()` evaluates it, counted. */
function chunk(): { load: () => Promise<unknown>; loads: () => number } {
  let loads = 0;
  return {
    load: async () => {
      loads += 1;
      installPageRuntime();
    },
    loads: () => loads,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('awaitPageRuntime', () => {
  test('a runtime already installed is the answer: nothing is loaded', async () => {
    installPageRuntime();
    const runtime = chunk();
    await awaitPageRuntime({ boot: BOOT, load: runtime.load });
    expect(runtime.loads()).toBe(0);
  });

  test('a document with no page boot loads the runtime chunk, once', async () => {
    const { asked } = parsingWith(null);
    const runtime = chunk();
    await awaitPageRuntime({ boot: BOOT, load: runtime.load });
    expect(asked).toEqual([`script[src^="${BOOT}"]`]);
    expect(runtime.loads()).toBe(1);
    expect(peekPageRealtime()?.store).toBeDefined();
  });

  test('a page boot still coming is waited for, and its runtime is the one used', async () => {
    const script = new FakeScript();
    parsingWith(script);
    const runtime = chunk();
    let done = false;
    const waiting = awaitPageRuntime({ boot: BOOT, load: runtime.load }).then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false); // the island did not run ahead of the boot it is rendered with

    installPageRuntime(); // the boot's body
    script.fire('load');
    await waiting;
    expect(runtime.loads()).toBe(0);
  });

  test('a page boot that failed to arrive is no runtime: the chunk is loaded instead', async () => {
    const script = new FakeScript();
    parsingWith(script);
    const runtime = chunk();
    const waiting = awaitPageRuntime({ boot: BOOT, load: runtime.load });
    script.fire('error');
    await waiting;
    expect(runtime.loads()).toBe(1);
  });

  test('a boot that ran and installed nothing is released by the window load', async () => {
    parsingWith(new FakeScript()); // its `load` already fired, before the island asked
    const runtime = chunk();
    const waiting = awaitPageRuntime({ boot: BOOT, load: runtime.load });
    dispatchEvent(new Event('load'));
    await waiting;
    expect(runtime.loads()).toBe(1);
  });

  // The concurrency audit: a boot that 404'd BEFORE the island asked fires no event again, and the
  // window's `load` waits on every image. Once DOMContentLoaded has fired, every deferred script
  // has run, so a missing runtime means the boot failed: load the chunk at once.
  test('a boot that failed before the island asked: past DOMContentLoaded, the chunk loads at once', async () => {
    parsingWith(new FakeScript()); // 'interactive', and its `error` already fired
    const realPerformance = globalThis.performance;
    Object.defineProperty(globalThis, 'performance', {
      value: { getEntriesByType: () => [{ domContentLoadedEventStart: 1234 }] },
      configurable: true,
    });
    try {
      const runtime = chunk();
      const waiting = awaitPageRuntime({ boot: BOOT, load: runtime.load });
      await settle();
      expect(runtime.loads()).toBe(1); // no event was waited for
      await waiting;
    } finally {
      Object.defineProperty(globalThis, 'performance', {
        value: realPerformance,
        configurable: true,
      });
    }
  });

  test('still parsing: DOMContentLoaded — after every deferred script — releases the wait', async () => {
    const script = new FakeScript();
    const ready = new FakeScript(); // the document's own listeners
    host.document = {
      readyState: 'loading',
      querySelector: () => script,
      addEventListener: (type: string, listener: () => void) =>
        ready.addEventListener(type, listener),
    };
    const runtime = chunk();
    const waiting = awaitPageRuntime({ boot: BOOT, load: runtime.load });
    await settle();
    expect(runtime.loads()).toBe(0);
    ready.fire('DOMContentLoaded');
    await waiting;
    expect(runtime.loads()).toBe(1);
  });

  test('a document past `complete` has run every deferred script: no boot is coming', async () => {
    let asked = false;
    host.document = {
      readyState: 'complete',
      querySelector: () => {
        asked = true;
        return new FakeScript();
      },
    };
    const runtime = chunk();
    await awaitPageRuntime({ boot: BOOT, load: runtime.load });
    expect(asked).toBe(false);
    expect(runtime.loads()).toBe(1);
  });

  test('a partial document (a component test stand-in) is no boot: the chunk is loaded', async () => {
    host.document = { readyState: 'interactive' };
    const runtime = chunk();
    await awaitPageRuntime({ boot: BOOT, load: runtime.load });
    expect(runtime.loads()).toBe(1);
  });
});
