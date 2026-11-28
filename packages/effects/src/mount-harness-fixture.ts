// TEST-ONLY. Mounts an entry the way an island does — DOM present, a Solid runtime registered,
// refs attached, effects run — over a fake page whose frame clock a test drives by hand. The
// runtime is a hand-written seven-function one (effects run after refs, cleanups on unmount), and
// every element is permissive: the question this harness serves is what an entry CALLS.

import { attachRef, nodesOf, type RenderNode } from '@ultimat3/core/render-nodes';
import { type SolidRuntime, setSolidRuntime } from '@ultimat3/ui';
// Deep, test-only: the slot's reset is not public API, and a registration left behind would leak
// into every later test file in this process.
import { clearSolidRuntime } from '../../ui/src/theme/runtime-slot';
import { FakeCanvas } from './fake-host-fixture';

type Listener = (event: unknown) => void;

/** An element: attributes, listeners, a box, a 2D/WebGL2 context, and a no-op for anything else. */
function fakeElement(tag: string, webgl2: boolean): Record<string, unknown> {
  const canvas = new FakeCanvas();
  if (!webgl2) canvas.gl = null;
  const base: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    textContent: '',
    style: { setProperty: () => {}, removeProperty: () => {} },
    dataset: {},
    setAttribute: canvas.setAttribute.bind(canvas),
    getAttribute: canvas.getAttribute.bind(canvas),
    removeAttribute: canvas.removeAttribute.bind(canvas),
    addEventListener: canvas.addEventListener.bind(canvas),
    removeEventListener: canvas.removeEventListener.bind(canvas),
    getContext: canvas.getContext.bind(canvas),
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, width: 400, height: 300 }),
    contains: () => false,
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    width: 300,
    height: 150,
  };
  return new Proxy(base, {
    get: (target, key) =>
      key in target ? target[key as string] : typeof key === 'string' ? () => undefined : undefined,
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
}

class FakeObserver {
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
  observe(target: unknown): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          contentRect: { width: 400, height: 300 },
        },
      ],
      this,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** The DOM globals a mount reaches. `frame()` runs every queued animation frame once. */
export interface FakePage {
  /** Runs every queued frame callback once; answers how many ran. */
  readonly frame: () => number;
  /** Hides or shows the tab, firing `visibilitychange`. */
  readonly setHidden: (hidden: boolean) => void;
  readonly restore: () => void;
}

const GLOBALS = [
  'document',
  'window',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'matchMedia',
  'getComputedStyle',
] as const;

export function installFakePage(): FakePage {
  const scope = globalThis as Record<string, unknown>;
  const saved = new Map(GLOBALS.map((name) => [name, scope[name]]));
  let queue = new Map<number, () => void>();
  let next = 0;
  let clock = 0;
  const html = fakeElement('html', false);
  const documentListeners = new Map<string, Set<Listener>>();
  const fakeDocument: Record<string, unknown> = {
    documentElement: html,
    hidden: false,
    visibilityState: 'visible',
    addEventListener: (type: string, fn: Listener) =>
      documentListeners.set(type, (documentListeners.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: Listener) => documentListeners.get(type)?.delete(fn),
  };
  Object.assign(scope, {
    document: fakeDocument,
    window: { devicePixelRatio: 2 },
    requestAnimationFrame: (fn: (now: number) => void) => {
      next += 1;
      queue.set(next, () => fn(clock));
      return next;
    },
    cancelAnimationFrame: (id: number) => queue.delete(id),
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    MutationObserver: FakeObserver,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '120 80 200' }),
  });
  return {
    frame: () => {
      clock += 16;
      const due = queue;
      queue = new Map();
      for (const run of due.values()) run();
      return due.size;
    },
    setHidden: (hidden) => {
      fakeDocument['hidden'] = hidden;
      fakeDocument['visibilityState'] = hidden ? 'hidden' : 'visible';
      for (const fn of documentListeners.get('visibilitychange') ?? []) fn({});
    },
    restore: () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete scope[name];
        else scope[name] = value;
      }
    },
  };
}

/** A seven-function runtime: effects queued until `flush`, cleanups kept for unmount. */
function harnessRuntime(effects: (() => void)[], cleanups: (() => void)[]): SolidRuntime {
  return {
    createContext: (defaultValue) => ({
      id: Symbol('ctx'),
      defaultValue,
      Provider: (p) => p.children,
    }),
    useContext: (context) => context.defaultValue,
    createSignal: (value) => {
      let current = value;
      return [() => current, (next) => (current = next)];
    },
    createMemo: (fn) => fn,
    createEffect: (fn) => effects.push(fn),
    onCleanup: (fn) => cleanups.push(fn),
    createRoot: (fn) => fn(() => {}),
  };
}

/** Renders `component`, hands every ref a fake element, runs its effects; the answer unmounts. */
export function mountEntry(
  component: unknown,
  props: Record<string, unknown>,
  options: { readonly webgl2?: boolean } = {},
): () => void {
  const effects: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  setSolidRuntime(harnessRuntime(effects, cleanups));
  try {
    const nodes: RenderNode[] = nodesOf((component as (p: unknown) => unknown)(props));
    for (const node of nodes) {
      if (typeof node.props['ref'] === 'function')
        attachRef(node, fakeElement(String(node.type), options.webgl2 ?? true));
    }
    for (const effect of effects) effect();
  } finally {
    clearSolidRuntime();
  }
  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
