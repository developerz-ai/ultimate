// An island's `mount` that never leaves a blank box: the server's markup is cleared for the live
// render and put BACK when that render throws. Framework-neutral — the caller hands in the draw
// (Solid's `render`), so this package takes no `solid-js` dependency and adds 167 B to a chunk.

/** What an island draws into its wrapper, answering the disposer (Solid's `render` does). */
export type IslandDraw = (root: HTMLElement) => () => void;

/**
 * Clear `el`, draw into it, and answer the draw's disposer. A draw that THROWS restores the server
 * markup it replaced — every node, in order, including whatever the draw half-inserted before it
 * failed being taken out — and rethrows the same error, once.
 *
 * Rethrown, never swallowed: the hydration runtime's `boot` (`hydrate.ts`) is what marks the root
 * `data-x-failed`, and `/x-client-errors.js` reports an island by that marker, once per element. A
 * swallowed throw would mark the island MOUNTED and reach no error tracker — a dead control that
 * looks alive. Reporting here as well would be the second report of one failure.
 *
 * The clear is still load-bearing on success: Solid's `render` APPENDS to a container with
 * children, so without it the server's copy stays on screen above the live one.
 *
 *   export function mount(el: HTMLElement, props: Props): () => void {
 *     return mountOver(el, (root) => render(() => <Counter {...props} />, root));
 *   }
 */
export function mountOver(el: HTMLElement, draw: IslandDraw): () => void {
  const server = Array.from(el.childNodes);
  el.textContent = '';
  try {
    return draw(el);
  } catch (error) {
    // Clear-then-append, not `replaceChildren`: the same two calls the success path relies on, so
    // no host that can run the island lacks the repair (`@ultimat3/testing`'s micro-DOM did).
    el.textContent = '';
    for (const node of server) el.appendChild(node);
    throw error;
  }
}
