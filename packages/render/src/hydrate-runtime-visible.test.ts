// The emitted hydration runtime, EXECUTED, for the two paths `hydrate-runtime.test.ts` does not
// hold: a `visible` island booted from an IntersectionObserver callback, and whose props an island
// boots with when two documents carry the same island id.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove, no tmpdir() and no path-join primitive; the
// runtime and its chunks are imported from a throwaway directory.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateRuntime, type IslandDirective } from './hydrate';

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'idle',
  entry: '/chunks/x1.js',
  ...overrides,
});

// The same rule for `visible`, which reaches `boot` from an IntersectionObserver callback — a
// stack with no caller left to hand a rejection to.
describe('the visible runtime, executed', () => {
  /** The import of the island is file I/O, not time: wait for the marker, bounded, never hang. */
  const waitFor = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 1_000 && !ready(); i += 1) {
      for (let m = 0; m < 8; m += 1) await Promise.resolve();
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
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
    let mounting = false;
    globals['__xTestMount'] = (): Promise<void> => {
      mounting = true;
      return gate;
    };

    const island = join(dir, 'island.mjs');
    await writeFile(island, 'export function mount(){return globalThis.__xTestMount()}\n', 'utf8');

    const attributes = new Map<string, string>([['data-x-entry', Bun.pathToFileURL(island).href]]);
    const element = {
      getAttribute: (name: string): string | null => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string): void => {
        attributes.set(name, value);
      },
      querySelector: (): unknown => null,
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
      await import(Bun.pathToFileURL(runtime).href);

      // Rejected only once `mount` holds the gate: earlier, nothing is listening for it yet.
      await waitFor(() => mounting);
      failMount('mount is not a function');
      await waitFor(() => attributes.has('data-x-failed'));

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

// Whose props an island boots with. An island id is `<moduleId>-<instance>` PER RENDER, so the
// page under a modal and the modal's own document both carry `like-1` — and a document-wide
// lookup hands the modal's island the page's props, the first match in tree order.
describe('the props an island boots with, executed', () => {
  interface PropsScript {
    readonly textContent: string;
    /** The island wrapper this script was emitted inside, `null` for one loose in the document. */
    closest(selector: string): unknown;
  }
  interface Wrapper {
    __x?: Promise<unknown>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    querySelector(selector: string): PropsScript | null;
    addEventListener(): void;
    removeEventListener(): void;
  }

  /** Boots the real `idle` runtime over these wrappers and answers the props each mounted with. */
  async function bootWith(
    build: (entry: string) => {
      readonly wrappers: readonly Wrapper[];
      readonly documentScripts: readonly { readonly id: string; readonly script: PropsScript }[];
    },
  ): Promise<readonly unknown[]> {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-props-'));
    const globals = globalThis as unknown as Record<string, unknown>;
    const island = join(dir, 'island.mjs');
    await writeFile(
      island,
      'export function mount(el,props){return globalThis.__xTestMount(el,props)}\n',
      'utf8',
    );
    const { wrappers, documentScripts } = build(Bun.pathToFileURL(island).href);
    const got = new Map<unknown, unknown>();
    globals['__xTestMount'] = (el: unknown, props: unknown): void => {
      got.set(el, props);
    };
    globals['document'] = {
      querySelectorAll: (selector: string): unknown[] =>
        selector.includes('idle') ? [...wrappers] : [],
      // Tree order, as a browser answers: the FIRST script carrying the id.
      querySelector: (selector: string): unknown =>
        documentScripts.find(({ id }) => selector === `script[data-x-props="${id}"]`)?.script ??
        null,
    };
    globals['window'] = {};
    try {
      const runtime = join(dir, 'runtime.mjs');
      const source = hydrateRuntime([directive({ strategy: 'idle' })])
        .replace('<script type="module">', '')
        .replace('</script>', '');
      await writeFile(runtime, source, 'utf8');
      await import(Bun.pathToFileURL(runtime).href);
      for (let i = 0; i < 1_000 && wrappers.some((el) => el.__x === undefined); i += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
      }
      await Promise.all(wrappers.map((el) => el.__x));
      return wrappers.map((el) => got.get(el));
    } finally {
      globals['document'] = undefined;
      globals['window'] = undefined;
      globals['__xTestMount'] = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  }

  const wrapper = (entry: string, id: string, own: PropsScript | null): Wrapper => {
    const attributes = new Map<string, string>([
      ['data-x-entry', entry],
      ['data-x-island', id],
    ]);
    return {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
      querySelector: (selector) => (selector === ':scope>script[data-x-props]' ? own : null),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  };

  const script = (props: object, inside: object | null): PropsScript => ({
    textContent: JSON.stringify(props),
    closest: (selector) => (selector === '[data-x-island]' ? inside : null),
  });

  test('two wrappers with one island id each boot with the props script inside themselves', async () => {
    const props = await bootWith((entry) => {
      const pageScript = script({ post: 'page' }, {});
      const modalScript = script({ post: 'modal' }, {});
      return {
        wrappers: [wrapper(entry, 'like-1', pageScript), wrapper(entry, 'like-1', modalScript)],
        documentScripts: [
          { id: 'like-1', script: pageScript },
          { id: 'like-1', script: modalScript },
        ],
      };
    });

    expect(props).toEqual([{ post: 'page' }, { post: 'modal' }]);
  });

  test('a wrapper carrying no props script never takes the one inside another wrapper', async () => {
    const props = await bootWith((entry) => {
      const pageScript = script({ post: 'page' }, {});
      return {
        wrappers: [wrapper(entry, 'like-1', pageScript), wrapper(entry, 'like-1', null)],
        documentScripts: [{ id: 'like-1', script: pageScript }],
      };
    });

    expect(props).toEqual([{ post: 'page' }, {}]);
  });

  // A hand-assembled document (`emitIslandProps` is public) may put the script beside the wrapper.
  test('a props script loose in the document still reaches the wrapper that has none', async () => {
    const props = await bootWith((entry) => ({
      wrappers: [wrapper(entry, 'settings', null)],
      documentScripts: [{ id: 'settings', script: script({ tab: 'profile' }, null) }],
    }));

    expect(props).toEqual([{ tab: 'profile' }]);
  });
});
