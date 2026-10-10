// Letting go of mounted islands: the one protocol for calling what each island's `mount` returned.
// The client router uses it when it swaps a page or closes a modal; an island that replaces markup
// holding OTHER islands (a live list redrawing rows whose menus are islands) uses it on the nodes
// it drops, through `@ultimat3/render/client`. Nothing else may read `el.__x`.

/** What `hydrate.ts`'s runtime leaves on an island root: the boot promise. */
interface IslandElement extends Element {
  __x?: Promise<unknown>;
}

const ISLAND_ATTRIBUTE = 'data-x-island';

/**
 * Disposes every island mounted under `root` — `root` itself included when it is an island's
 * wrapper — unless `kept` claims it, and answers how many had a boot to settle. For each one the
 * disposer is what its `mount` returned (held by `el.__x`), called once that boot resolves; a
 * `mount` that returned nothing has nothing to call. A rejected boot has nothing to dispose, and
 * the rejection is already on the element as `data-x-failed`. An island whose boot has not STARTED
 * (an `idle` one still waiting for the browser, a `visible` one never scrolled to) is settled
 * instead: the hydration runtime's `boot` answers an element that already has `__x` with it, so
 * the pending boot mounts nothing into markup that left the document — a mount nobody would ever
 * dispose. Works on a detached subtree, so the order against removing `root` does not matter.
 */
export function disposeIslands(
  root: Element,
  kept: (el: Element) => boolean = () => false,
): number {
  let disposed = 0;
  const under = root.querySelectorAll<IslandElement>(`[${ISLAND_ATTRIBUTE}]`);
  const islands: Iterable<IslandElement> = root.hasAttribute(ISLAND_ATTRIBUTE)
    ? [root, ...under]
    : under;
  for (const el of islands) {
    if (kept(el)) continue;
    if (el.__x === undefined) {
      el.__x = Promise.resolve();
      continue;
    }
    disposed += 1;
    el.__x.then(
      (dispose) => {
        if (typeof dispose === 'function') dispose();
      },
      () => undefined,
    );
  }
  return disposed;
}
