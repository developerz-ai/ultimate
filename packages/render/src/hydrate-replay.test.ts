// WHERE the interaction runtime replays the event it caught — the one thing `hydrate-runtime.test.ts`
// cannot see, because its element is both the island root and the event's target, so "dispatch at
// `ev.target`" and "dispatch at the island" are the same node there. Every island whose `mount`
// clears the wrapper detaches that target, and the click that woke the island went to a node no
// longer in the document: "the button does nothing on the first press, and works on the second".

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hydrateRuntime, type IslandDirective } from './hydrate';

/** A pointer event carries coordinates; a keyboard one carries none, and that is the whole
 *  difference between the two fallbacks below. */
interface FireInit {
  readonly target: FakeElement;
  readonly clientX?: number;
  readonly clientY?: number;
}

class FakeEvent {
  readonly type: string;
  readonly target: unknown;
  readonly clientX: number | undefined;
  readonly clientY: number | undefined;
  constructor(type: string, init: Partial<FireInit>) {
    this.type = type;
    this.target = init.target;
    this.clientX = init.clientX;
    this.clientY = init.clientY;
  }
}

type Listener = (event: FakeEvent) => void;

/** Just enough element for the runtime: attributes, a parent chain `contains` can walk, listeners,
 *  and a record of what was dispatched AT this node — which is the assertion. */
class FakeElement {
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

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

  dispatchEvent(event: FakeEvent): boolean {
    this.delivered.push(event.type);
    return true;
  }

  /** Drive the capture listener the runtime attached to the wrapper. */
  fire(type: string, init: FireInit): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new FakeEvent(type, init));
  }
}

interface Harness {
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
  readonly dispose: () => Promise<void>;
}

/** The two shapes the aiming rule has to tell apart: one with coordinates, one without. */
const REPLAY_EVENTS = ['click', 'keydown'] as const;

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'interaction',
  entry: '/chunks/x1.js',
  ...overrides,
});

/** One turn, so a promise chain that WOULD have flushed has flushed. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** `replaces` is the documented island idiom — `mount` opens with `el.textContent = ''`. */
async function bootReplayRuntime(replaces: boolean): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-replay-'));
  const globals = globalThis as unknown as Record<string, unknown>;

  const root = new FakeElement('div');
  const shell = new FakeElement('button');
  root.appendChild(shell);
  const mounted = new FakeElement('button');
  const outsider = new FakeElement('header');

  let finishMount = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    finishMount = resolve;
  });
  // The island's `mount`, as an island really writes it. The gate is what a chunk still resolving
  // its own imports looks like from the runtime's side.
  globals['__xTestMount'] = (el: FakeElement): Promise<void> =>
    gate.then(() => {
      if (!replaces) return;
      el.empty();
      el.appendChild(mounted);
    });

  const island = join(dir, 'island.mjs');
  await writeFile(
    island,
    'export function mount(el){return globalThis.__xTestMount(el)}\n',
    'utf8',
  );
  root.setAttribute('data-x-entry', pathToFileURL(island).href);
  // What `emitIslandAttributes` writes for the same directive. Without it the runtime falls back
  // to `click` alone and a `keydown` fired below reaches no listener at all.
  root.setAttribute('data-x-events', REPLAY_EVENTS.join(' '));

  const hits = new Map<string, FakeElement>();
  globals['document'] = {
    querySelectorAll: (selector: string): unknown[] =>
      selector.includes('interaction') ? [root] : [],
    // No props script: the island takes none, so `boot` must still reach the import.
    querySelector: (): unknown => null,
    elementFromPoint: (x: number, y: number): unknown => hits.get(`${x},${y}`) ?? null,
  };

  const runtime = join(dir, 'runtime.mjs');
  const source = hydrateRuntime([directive({ events: REPLAY_EVENTS })])
    .replace('<script type="module">', '')
    .replace('</script>', '');
  await writeFile(runtime, source, 'utf8');
  await import(pathToFileURL(runtime).href);

  return {
    root,
    shell,
    mounted,
    outsider,
    hits,
    fire: (type, init = {}) => {
      root.fire(type, { target: shell, ...init });
    },
    finishMount,
    dispose: async () => {
      globals['document'] = undefined;
      globals['__xTestMount'] = undefined;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('the interaction replay aims at a node the mount left standing', () => {
  test('a mount that takes the shell OVER replays onto the very node that was pressed', async () => {
    // `contact-sales.island.tsx` queries the server's form and attaches to it rather than replacing
    // it, so the pressed node is still the right one and has to stay the answer.
    const harness = await bootReplayRuntime(false);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);

      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a mount that REPLACES the shell replays onto what now sits under the pointer', async () => {
    // The defect: `ev.target` is the server's button, detached by `el.textContent = ''`, so the
    // click that woke the island was dispatched into nothing and the user pressed twice.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('12,34', harness.mounted);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      // The detached node is not merely a worse target, it is nobody's: a replay it receives is a
      // replay the mounted control did not.
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('an event with no coordinates falls back to the island root, never the detached node', async () => {
    // A `keydown` has no `clientX`, so there is no point to hit-test. The root still reaches a
    // listener the island registered on `document` — `@ultimat3/ui`'s Escape handlers are all
    // there — which a node outside the tree reaches nothing from.
    const harness = await bootReplayRuntime(true);
    try {
      harness.fire('keydown');
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.root.delivered).toEqual(['keydown']);
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a hit test landing OUTSIDE the island falls back to the root, not to a stranger', async () => {
    // The island may have mounted something smaller, or a sticky header may now cover the point.
    // Synthesizing a click on an element the visitor never pressed is worse than losing the replay.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('12,34', harness.outsider);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.outsider.delivered).toEqual([]);
      expect(harness.root.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('a pointer event at the origin is still hit-tested — 0 is a coordinate', async () => {
    // `ev.clientX || ev.clientY` reads (0, 0) as "no coordinates" and sends a real click to the
    // root. The top-left corner is where a full-bleed island's first pixel is.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('0,0', harness.mounted);
    try {
      harness.fire('click', { clientX: 0, clientY: 0 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
