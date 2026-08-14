/**
 * `<Suspense>` for `render: 'stream'` routes. NOT solid-js's own: `@ultimat3/render`'s server JSX
 * factory (`packages/render/src/jsx.ts`) builds an inert tree and calls a component as a plain
 * function (`packages/render/src/render-html.ts`'s `renderNode`) — there is no Solid owner, so
 * solid-js's `Suspense` throws `getContextId cannot be used under non-hydrating context` the
 * moment it is invoked outside Solid's own renderer.
 *
 * `packages/cli/src/dev-render.ts`'s `stream` case names the real gap directly: nothing yet
 * splits a page into holes, so the first flush already carries the whole body — this shim's
 * `fallback` is therefore dead code today, on purpose, matching that behavior exactly. What it
 * buys is the authoring shape (`fallback` + `children`, an async child included) staying stable
 * for the day a Solid-aware pipeline lands, without crashing the pages written against it now.
 */

import type { JSX } from 'solid-js';

export function Suspense(props: {
  readonly fallback?: JSX.Element;
  readonly children?: JSX.Element;
}): JSX.Element {
  return props.children;
}
