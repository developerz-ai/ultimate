// A function child, typed. Solid's compiler makes every JSX expression one anyway; written as a
// function so a test that walks the tree after a tick (render-nodes calls thunks) reads it as it
// is NOW. Solid's `jsx.d.ts` types no function child (its `jsx-h.d.ts` does), hence the one cast.

import type { JSX } from 'solid-js';

export function thunk(fn: () => JSX.Element): JSX.Element {
  return fn as unknown as JSX.Element;
}
