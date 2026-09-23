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
  /** Run the `requestIdleCallback` the idle runtime scheduled — the moment `idle` starts booting. */
  readonly goIdle: () => void;
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
async function bootReplayRuntime(
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
    goIdle: () => {
      idle();
    },
    dispose: async () => {
      globals['document'] = undefined;
      globals['window'] = undefined;
      globals['requestIdleCallback'] = undefined;
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

  test('an event with no coordinates lands on the control the mount put where it was', async () => {
    // A `keydown` has no `clientX`, so there is no point to hit-test. The path to the pressed node
    // was taken when the event was caught, and the mount rendered the same element at the same
    // place: that is the control the visitor was on. The island ROOT reaches no handler on it —
    // Solid delegates from `document` and walks UP from the target.
    const harness = await bootReplayRuntime(true);
    try {
      harness.fire('keydown');
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['keydown']);
      expect(harness.root.delivered).toEqual([]);
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a scripted or keyboard click at (0, 0) is not hit-tested — it names no point', async () => {
    // `button.click()` and Enter on a focused button both fire `click` with `detail: 0` and
    // `clientX: 0`. Hit-testing the page's top-left corner found nothing in the island, the replay
    // went to the root, and the press was lost — the dummy's e2e suite presses exactly this way.
    const harness = await bootReplayRuntime(true);
    // A full-bleed island covers the corner: a hit test there answers the island's own wrapper,
    // which is inside it and reaches no handler of the control.
    harness.hits.set('0,0', harness.root);
    try {
      harness.fire('click', { clientX: 0, clientY: 0, detail: 0 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a mount that rendered a DIFFERENT element there falls back to the root', async () => {
    // The path found an `<a>` where a `<button>` was pressed: not the same control, and
    // synthesizing an event on an element the visitor never touched is worse than losing it.
    const harness = await bootReplayRuntime(true, 'interaction', 'a');
    try {
      harness.fire('keydown');
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual([]);
      expect(harness.root.delivered).toEqual(['keydown']);
    } finally {
      await harness.dispose();
    }
  });

  test('a hit test landing OUTSIDE the island never reaches the stranger', async () => {
    // The island may have mounted something smaller, or a sticky header may now cover the point.
    // Synthesizing a click on an element the visitor never pressed is worse than losing the replay;
    // the structural answer — the same control at the same place — is still the island's own.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('12,34', harness.outsider);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.outsider.delivered).toEqual([]);
      expect(harness.mounted.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('outside the island AND a different element there: the root, never the stranger', async () => {
    const harness = await bootReplayRuntime(true, 'interaction', 'a');
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

// `idle` hydrates on the browser's schedule, not the visitor's, so the server-rendered button is
// pressable for as long as the idle callback and the chunk take — up to IDLE_HYDRATE_TIMEOUT_MS
// plus a download. A click in that window reached a node with no handler and vanished: every app's
// first press could do nothing. The same capture-and-replay `interaction` runs covers it.
describe('an idle island replays what the visitor did before it mounted', () => {
  test('a click BEFORE the idle callback runs is replayed once the island mounts', async () => {
    const harness = await bootReplayRuntime(true, 'idle');
    harness.hits.set('12,34', harness.mounted);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      // Nothing is replayed into a chunk still loading.
      expect(harness.mounted.delivered).toEqual([]);

      harness.goIdle();
      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.shell.delivered).toEqual([]);
      expect(harness.root.listening()).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a press wakes an idle island without waiting for the browser to go idle', async () => {
    // The visitor has already said they want it; waiting out IDLE_HYDRATE_TIMEOUT_MS on a busy
    // main thread would turn a replayed click into a two-second one.
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
      // The idle callback arriving afterwards finds nothing left to replay.
      harness.goIdle();
      await settle();
      expect(harness.shell.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('a click while the chunk is still loading is replayed after mount, not before', async () => {
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      harness.goIdle();
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);

      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('an idle island nobody touched lets go of its listeners once mounted', async () => {
    // A listener left attached would re-dispatch every later click a second time.
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      expect(harness.root.listening()).toEqual([...REPLAY_EVENTS]);
      harness.goIdle();
      harness.finishMount();
      await settle();

      expect(harness.root.listening()).toEqual([]);
      harness.fire('click', { clientX: 1, clientY: 1 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
