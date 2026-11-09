// The one `ResizeObserver` a virtual list holds: its box (the viewport) and every rendered row (by
// `data-key`), reported as numbers. Its own module so the component stays markup, and so a list
// that never mounts in a browser — every server render — never constructs one.

export interface VirtualListSizes {
  /** The box's block size, when it changed. */
  readonly viewport?: number | undefined;
  /** Rows whose measured block size changed, by key. */
  readonly rows: ReadonlyMap<string, number>;
}

export interface VirtualListObserver {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

/** `undefined` where there is no `ResizeObserver`: the estimate then stands for every row. */
export function createVirtualListObserver(
  box: Element,
  report: (sizes: VirtualListSizes) => void,
): VirtualListObserver | undefined {
  if (typeof ResizeObserver === 'undefined') return undefined;
  // Reported a frame later, batched: a report that re-lays the list out from inside the observer's
  // own callback mounts rows it then has to measure in the same frame, which is the platform's
  // "ResizeObserver loop completed with undelivered notifications" — an error event per frame.
  let viewport: number | undefined;
  let rows = new Map<string, number>();
  let frame: number | undefined;
  const flush = (): void => {
    frame = undefined;
    const sizes = { viewport, rows };
    viewport = undefined;
    rows = new Map();
    report(sizes);
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === box) {
        viewport = (entry.target as HTMLElement).clientHeight;
        continue;
      }
      const key = (entry.target as HTMLElement).dataset['key'];
      const size = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      if (key !== undefined) rows.set(key, size);
    }
    frame ??= requestAnimationFrame(flush);
  });
  observer.observe(box);
  return {
    observe: (element) => observer.observe(element),
    unobserve: (element) => observer.unobserve(element),
    disconnect: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
