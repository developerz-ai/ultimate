// Single responsibility: the stubs live on one target, as a stack. A test's stub over a file's
// stub answers for that test and hands the FILE's stub back when it ends — never the declared body
// — and a stub undone out of order removes only itself (frames by identity, not by position).

import type { Undo } from './test-scope';

/** Push `handle` over a target; `apply` puts the top (or, emptied, nothing) in place. */
export type StubPush<H> = (target: object, handle: H, apply: (top: H | undefined) => void) => Undo;

/** One stack per target, for one kind of seam. */
export function stubStack<H>(): StubPush<H> {
  const stacks = new WeakMap<object, { readonly handle: H }[]>();
  return (target, handle, apply) => {
    const frames = stacks.get(target) ?? [];
    stacks.set(target, frames);
    // A frame per push, so one handle pushed twice is still two frames.
    const frame = { handle };
    frames.push(frame);
    apply(handle);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const at = frames.indexOf(frame);
      if (at !== -1) frames.splice(at, 1);
      apply(frames.at(-1)?.handle);
    };
  };
}
