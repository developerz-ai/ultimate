// The document `hydrate-replay.test.ts` runs the emitted hydration runtime against: fake elements
// that record what was dispatched AT them, and a boot that writes the runtime and one island chunk
// to a throwaway directory. A fixture, never shipped: no test of its own.

// why: Bun has no mkdtemp, no recursive remove, no tmpdir() and no path-join primitive; the
// runtime and its chunks are imported from a throwaway directory.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateRuntime, type IslandDirective } from './hydrate';

/** A pointer event carries coordinates; a keyboard one carries none, and that is the whole
 *  difference between the two fallbacks below. */
interface FireInit {
  readonly target: FakeElement;
  readonly clientX?: number;
  readonly clientY?: number;
  /** A UI event's click count: 0 on a keyboard-activated or scripted `click()`, whose (0, 0) is
   *  no pointer position at all. */
  readonly detail?: number;
}

class FakeEvent {
  readonly type: string;
  readonly target: unknown;
  readonly clientX: number | undefined;
  readonly clientY: number | undefined;
  readonly detail: number | undefined;
  constructor(type: string, init: Partial<FireInit>) {
    this.type = type;
    this.target = init.target;
    this.clientX = init.clientX;
    this.clientY = init.clientY;
    this.detail = init.detail;
  }
}

type Listener = (event: FakeEvent) => void;

/** Just enough element for the runtime: attributes, a parent chain `contains` can walk, listeners,
 *  and a record of what was dispatched AT this node — which is the assertion. */
export class FakeElement {
  readonly tag: string;
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeElement[] = [];
  /** Event types re-dispatched onto this node by the replay. */
  readonly delivered: string[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tag = tag;
  }

  /** Upper case, as the DOM answers it for an HTML element. */
  get tagName(): string {
    return this.tag.toUpperCase();
  }

  /** Element children only — every child here is an element. */
  get children(): readonly FakeElement[] {
    return this.childNodes;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** No test here hands an island props, so the wrapper holds no props script. */
  querySelector(): null {
    return null;
  }

  appendChild(child: FakeElement): void {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  /** `el.textContent = ''` in one method — the line every replacing `mount` opens with. */
  empty(): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
  }

  contains(node: unknown): boolean {
    for (let at = node as FakeElement | null; at != null; at = at.parentNode) {
      if (at === this) return true;
    }
    return false;
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((one) => one !== fn),
    );
  }

  /** Event types a listener is still attached for — empty once the runtime has let go. */
  listening(): string[] {
    return [...this.listeners].filter(([, fns]) => fns.length > 0).map(([type]) => type);
  }

  dispatchEvent(event: FakeEvent): boolean {
    this.delivered.push(event.type);
    return true;
  }

  /** Drive the capture listener the runtime attached to the wrapper. */
  fire(type: string, init: FireInit): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new FakeEvent(type, init));
  }
}

export interface Harness {
  /** The island wrapper — what `mount` is handed, and the last-resort replay target. */
  readonly root: FakeElement;
  /** The server-rendered control inside the wrapper, which a replacing mount detaches. */
  readonly shell: FakeElement;
  /** What the island's own `mount` renders, when it replaces. */
  readonly mounted: FakeElement;
  /** A node the island does not own — a sticky header, an overlay — for the hit-test guard. */
  readonly outsider: FakeElement;
  /** What `document.elementFromPoint` answers, keyed `"<x>,<y>"`. Filled by the test. */
  readonly hits: Map<string, FakeElement>;
  readonly fire: (type: string, init?: Partial<FireInit>) => void;
  readonly finishMount: () => void;
  /** Run the `requestIdleCallback` the idle runtime scheduled — the moment `idle` starts booting. */
  readonly goIdle: () => void;
  readonly dispose: () => Promise<void>;
}

/** The two shapes the aiming rule has to tell apart: one with coordinates, one without. */
export const REPLAY_EVENTS = ['click', 'keydown'] as const;

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'interaction',
  entry: '/chunks/x1.js',
  ...overrides,
});

/** The `mount` call the running harness has set in motion, which `settle` waits on. */
let mountExpected: Promise<void> | undefined;

/**
 * The expected `mount` call, then one turn, so a promise chain that WOULD have flushed has flushed.
 * Awaited as an event: how many loop turns the runtime's `import()` takes is Bun's to change.
 */
export const settle = async (): Promise<void> => {
  await mountExpected;
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** `replaces` is the documented island idiom — `mount` opens with `el.textContent = ''`. */
export async function bootReplayRuntime(
  replaces: boolean,
  strategy: 'interaction' | 'idle' = 'interaction',
  mountedTag = 'button',
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-replay-'));
  const globals = globalThis as unknown as Record<string, unknown>;

  const root = new FakeElement('div');
  const shell = new FakeElement('button');
  root.appendChild(shell);
  // The island's own render of the shell's control — the same element at the same place, unless a
  // test says the mount rendered something else there.
  const mounted = new FakeElement(mountedTag);
  const outsider = new FakeElement('header');

  let finishMount = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    finishMount = resolve;
  });
  // The island's `mount`, as an island really writes it. The gate is what a chunk still resolving
  // its own imports looks like from the runtime's side.
  const mountCalled = Promise.withResolvers<void>();
  globals['__xTestMount'] = (el: FakeElement): Promise<void> => {
    mountCalled.resolve();
    return gate.then(() => {
      if (!replaces) return;
      el.empty();
      el.appendChild(mounted);
    });
  };

  const island = join(dir, 'island.mjs');
  await writeFile(
    island,
    'export function mount(el){return globalThis.__xTestMount(el)}\n',
    'utf8',
  );
  root.setAttribute('data-x-entry', Bun.pathToFileURL(island).href);
  // What `emitIslandAttributes` writes for the same directive. Without it the runtime falls back
  // to `click` alone and a `keydown` fired below reaches no listener at all.
  root.setAttribute('data-x-events', REPLAY_EVENTS.join(' '));

  const hits = new Map<string, FakeElement>();
  globals['document'] = {
    querySelectorAll: (selector: string): unknown[] =>
      selector.includes(`"${strategy}"`) ? [root] : [],
    // No props script: the island takes none, so `boot` must still reach the import.
    querySelector: (): unknown => null,
    elementFromPoint: (x: number, y: number): unknown => hits.get(`${x},${y}`) ?? null,
  };
  // The idle callback is held rather than run, so a test decides whether the visitor pressed
  // before the browser went idle or after — the two windows `idle` used to lose a click in.
  let idle = (): void => undefined;
  // The runtime feature-tests on `window` and then calls the bare global, as a browser allows.
  const requestIdleCallback = (fn: () => void): void => {
    idle = fn;
  };
  globals['requestIdleCallback'] = requestIdleCallback;
  globals['window'] = { requestIdleCallback };

  const runtime = join(dir, 'runtime.mjs');
  const source = hydrateRuntime([directive({ strategy, events: REPLAY_EVENTS })])
    .replace('<script type="module">', '')
    .replace('</script>', '');
  await writeFile(runtime, source, 'utf8');
  await import(Bun.pathToFileURL(runtime).href);

  return {
    root,
    shell,
    mounted,
    outsider,
    hits,
    fire: (type, init = {}) => {
      // A press boots the island under either strategy.
      mountExpected = mountCalled.promise;
      root.fire(type, { target: shell, ...init });
    },
    finishMount: () => {
      mountExpected = mountCalled.promise;
      finishMount();
    },
    goIdle: () => {
      idle();
    },
    dispose: async () => {
      mountExpected = undefined;
      globals['document'] = undefined;
      globals['window'] = undefined;
      globals['requestIdleCallback'] = undefined;
      globals['__xTestMount'] = undefined;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
