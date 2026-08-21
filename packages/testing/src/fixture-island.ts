// Build one island, import the chunk the way the hydration runtime does, and run its `mount` over
// the micro-DOM. The BUILDER arrives as a parameter — `@ultimat3/cli` owns `buildIslands` and both
// packages are tier 5, so importing it here would be the reverse of the one declared `cli → testing`
// edge. A structural seam keeps the direction honest and survives the bundler changing underneath.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { islandMountMissing, islandNotBuilt } from './errors';
import { createIslandDocument, FakeElement, handlerFor, parseHtml } from './island-dom';

/** The two fields a mounted island needs from a chunk. Anything else a bundler grows — a CSS
 *  artifact, a source map, a dev/production flag — is invisible here on purpose. */
export interface IslandChunkLike {
  /** App-root-relative POSIX path of the client entry the chunk was built from. */
  readonly file: string;
  /** The built JavaScript, self-contained: an island chunk imports nothing at runtime. */
  readonly code: string;
}

export interface IslandBundleLike {
  readonly chunks: readonly IslandChunkLike[];
}

/** `buildIslands` from `@ultimat3/cli` satisfies this structurally — no import, no new tier edge. */
export type IslandBuilder = (root: string) => Promise<IslandBundleLike>;

export interface MountIslandOptions {
  readonly build: IslandBuilder;
  /** The app root the builder globs from. */
  readonly root: string;
  /** Which island, app-root-relative. Always named: an app with two islands has no default. */
  readonly file: string;
  /** The JSON the document would carry in `data-x-props`. */
  readonly props?: unknown;
  /** The markup the server rendered inside the island's wrapper, which `mount` must replace. */
  readonly shell?: string;
  /** Anything the micro-DOM does not supply — `fetch` above all. Merged over the DOM globals. */
  readonly globals?: Readonly<Record<string, unknown>>;
}

export interface MountedIsland extends Disposable {
  /** The chunk's source, for asserting on what did or did not reach the browser. */
  readonly code: string;
  /** The host element `mount` was given. */
  readonly el: FakeElement;
  /** The `<html>` this mount wrote to — `documentElement.dataset` is a real island's only door out. */
  readonly documentElement: FakeElement;
  find(selector: string): FakeElement | null;
  all(selector: string): readonly FakeElement[];
  /** `textContent` of the first match, `''` when there is none — an assertion reads a string. */
  text(selector: string): string;
  /**
   * Drive a handler the compiled island attached, delegated (`$$change`) or not. Answers whether
   * one RAN: a selector that matches nothing and an island that attached no handler are the same
   * silence otherwise, and the second is a bug while the first is a typo in the test.
   */
  fire(
    target: string | FakeElement | null | undefined,
    type: string,
    event?: Readonly<Record<string, unknown>>,
  ): boolean;
}

interface IslandEntry {
  readonly mount: (el: unknown, props: unknown) => void;
}

/** `unknown` + a check, not a cast: a chunk whose `mount` was renamed is a real authoring mistake
 *  and `entry.mount is not a function` names neither the file nor the export it wanted. */
function entryOf(module: unknown, file: string): IslandEntry {
  const mount = (module as Record<string, unknown> | null)?.['mount'];
  if (typeof mount !== 'function') {
    throw islandMountMissing(file, Object.keys((module as object | null) ?? {}));
  }
  return { mount: mount as IslandEntry['mount'] };
}

/** One directory per process, outside the app under test — so no test leaves a `.mjs` behind. */
const MODULE_DIR = mkdtempSync(join(tmpdir(), 'ultimate-island-'));

/**
 * A temp file named by the chunk's own hash, NOT a `data:` URL. The URL form read better and
 * crashed the coverage reporter: `bun test --coverage` panics with `range end index N out of range
 * for slice of length 4096` on `import()` of any `data:` module whose URL exceeds ~4 kB, and an
 * island chunk is 12-55 kB. Measured on Bun 1.4.0, threshold at a URL length of 4032; without
 * `--coverage` the same import is fine, which is why only the per-package CI job ever saw it.
 *
 * The property the URL form was chosen for survives: the name is derived from the bytes, so an
 * edited island is a different module rather than a cache hit on the same path.
 */
const moduleUrlFor = (code: string): string =>
  join(MODULE_DIR, `${Bun.SHA256.hash(code, 'hex').slice(0, 16)}.mjs`);

function installGlobals(values: Readonly<Record<string, unknown>>): () => void {
  const host = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(Object.keys(values).map((key) => [key, host[key]]));
  Object.assign(host, values);
  return (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete host[key];
      else host[key] = value;
    }
  };
}

/**
 * The island fixture. Everything it installs is process-global, so the result is `Disposable` and
 * the idiom is `using mounted = await mountIsland(…)` — a mount left installed hands a fake
 * `document` to every later FILE in the run.
 */
export async function mountIsland(options: MountIslandOptions): Promise<MountedIsland> {
  const bundle = await options.build(options.root);
  const chunk = bundle.chunks.find((each) => each.file === options.file);
  if (chunk === undefined) {
    throw islandNotBuilt(
      options.file,
      options.root,
      bundle.chunks.map((each) => each.file),
    );
  }

  const { documentElement, globals } = createIslandDocument();
  const restore = installGlobals({ ...globals, ...options.globals });
  try {
    const path = moduleUrlFor(chunk.code);
    await Bun.write(path, chunk.code);
    const entry = entryOf(await import(path), chunk.file);
    const el = new FakeElement('div');
    if (options.shell !== undefined) {
      for (const child of [...parseHtml(options.shell).children]) el.appendChild(child);
    }
    entry.mount(el, options.props);
    return {
      code: chunk.code,
      el,
      documentElement,
      find: (selector) => el.querySelector(selector),
      all: (selector) => el.querySelectorAll(selector),
      text: (selector) => el.querySelector(selector)?.textContent ?? '',
      fire: (target, type, event) => {
        const node = typeof target === 'string' ? el.querySelector(target) : target;
        const handler = node == null ? undefined : handlerFor(node, type);
        if (handler === undefined) return false;
        handler({ currentTarget: node, target: node, ...event });
        return true;
      },
      [Symbol.dispose]: restore,
    };
  } catch (error) {
    // A mount that throws restores the process before it rethrows: the alternative leaves every
    // later file in the run holding a fake `document`, which fails somewhere with no thread back.
    restore();
    throw error;
  }
}
