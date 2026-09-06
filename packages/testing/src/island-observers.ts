// `ResizeObserver`, as much of it as a compiled island calls and a test can drive. Split out of
// `island-dom.ts` at the 500-line ceiling.
//
// `bun test` has no `ResizeObserver` at all, so an island that measures its box — a virtualized
// list sizing its window, a terminal computing rows and columns — either guarded the constructor
// and took a fallback path no browser takes, or threw `ResizeObserver is not defined` inside
// `mount`. Neither is the island a browser runs. The stub RECORDS: `observe`, `unobserve` and
// `disconnect` keep a set per observer, and `deliverResize` is the test's hand on the browser's
// layout — it calls every observer watching THAT element, and no other, with an entry shaped the
// way the spec shapes one.
//
// `observe()` fires nothing. A browser delivers an initial notification at the next rendering
// opportunity, which is after `mount` has returned; here that opportunity is the test's own
// `mounted.resize(...)`, made when the test decides what the layout is. A stub that fired inside
// `observe` would re-enter the island mid-`mount` from a place no browser does.

/** The size a test hands an element — either axis alone is fine; the other keeps its value. */
export interface ResizeInput {
  readonly width?: number;
  readonly height?: number;
}

/** The size fields `deliverResize` writes, so an island's own `clientHeight` read agrees with
 *  the entry it was handed. Structural, so this module imports no DOM class. */
export interface SizedElement {
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
}

/** `DOMRectReadOnly`, as the spec's `contentRect` — every member, because an island may read any. */
export interface ResizeRect {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

export const rectOf = (width: number, height: number): ResizeRect => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  width,
  height,
  right: width,
  bottom: height,
});

/** One entry of the list a `ResizeObserver` callback receives. All three box lists are the same
 *  box: this DOM has no padding or border to tell them apart by. */
export interface FakeResizeObserverEntry<TElement extends object> {
  readonly target: TElement;
  readonly contentRect: ResizeRect;
  readonly borderBoxSize: readonly { readonly inlineSize: number; readonly blockSize: number }[];
  readonly contentBoxSize: readonly { readonly inlineSize: number; readonly blockSize: number }[];
  readonly devicePixelContentBoxSize: readonly {
    readonly inlineSize: number;
    readonly blockSize: number;
  }[];
}

export type ResizeCallback<TElement extends object> = (
  entries: readonly FakeResizeObserverEntry<TElement>[],
  observer: FakeResizeObserver<TElement>,
) => void;

export class FakeResizeObserver<TElement extends object = object> {
  readonly targets = new Set<TElement>();
  constructor(
    private readonly registry: Set<FakeResizeObserver<TElement>>,
    private readonly callback: ResizeCallback<TElement>,
  ) {
    registry.add(this);
  }
  observe(target: TElement): void {
    this.targets.add(target);
  }
  unobserve(target: TElement): void {
    this.targets.delete(target);
  }
  /** Out of the registry too: an observer an island disconnected in `onCleanup` is gone, and a
   *  later `resize` must not reach it — that is the assertion a teardown test makes. */
  disconnect(): void {
    this.targets.clear();
    this.registry.delete(this);
  }
  deliver(target: TElement, rect: ResizeRect): void {
    const box = [{ inlineSize: rect.width, blockSize: rect.height }];
    this.callback(
      [
        {
          target,
          contentRect: rect,
          borderBoxSize: box,
          contentBoxSize: box,
          devicePixelContentBoxSize: box,
        },
      ],
      this,
    );
  }
}

/**
 * The per-document registry and the constructor an island sees as `ResizeObserver`. Per DOCUMENT,
 * never module scope: an observer one mount left behind must not receive the next mount's resize,
 * and `createIslandDocument` is built fresh per mount for exactly that class of state.
 */
export function createResizeObservers<TElement extends object>(): {
  readonly registry: Set<FakeResizeObserver<TElement>>;
  readonly ResizeObserver: new (callback: ResizeCallback<TElement>) => FakeResizeObserver<TElement>;
} {
  const registry = new Set<FakeResizeObserver<TElement>>();
  const ResizeObserver = class extends FakeResizeObserver<TElement> {
    constructor(callback: ResizeCallback<TElement>) {
      super(registry, callback);
    }
  };
  return { registry, ResizeObserver };
}

/**
 * Write the size onto the element and notify every observer watching it. Answers whether ANY
 * observer ran, for `fire`'s reason: an element nothing observes and an island that never called
 * `observe` are the same silence otherwise, and the second is the bug.
 *
 * Both `client*` and `offset*` move together. This DOM lays nothing out, so the two are one number
 * — an island reading either after a resize sees the size the entry carried.
 */
export function deliverResize<TElement extends SizedElement>(
  registry: ReadonlySet<FakeResizeObserver<TElement>>,
  target: TElement,
  size: ResizeInput,
): boolean {
  if (size.width !== undefined) {
    target.clientWidth = size.width;
    target.offsetWidth = size.width;
  }
  if (size.height !== undefined) {
    target.clientHeight = size.height;
    target.offsetHeight = size.height;
  }
  const rect = rectOf(target.clientWidth, target.clientHeight);
  let delivered = false;
  // A copy: a callback that disconnects its observer mutates the registry under the walk.
  for (const observer of [...registry]) {
    if (!observer.targets.has(target)) continue;
    observer.deliver(target, rect);
    delivered = true;
  }
  return delivered;
}
