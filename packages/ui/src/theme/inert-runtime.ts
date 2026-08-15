// The runtime a server render gets: signals that hold, memos that recompute on read, effects and
// cleanups that never run. It is what a static page IS — markup with no reactive graph behind it —
// so nothing here is a stub waiting for a real implementation.

import type { Accessor, Setter, SolidContext, SolidRuntime } from './solid-adapter';

/**
 * One frozen instance, never a factory. `uiContext()` caches its context keyed on runtime
 * identity, so a fresh object per call would rebuild the context on every read and hand two
 * consumers two contexts that are equal and not the same.
 */
export const INERT_SOLID_RUNTIME: SolidRuntime = Object.freeze({
  createContext: <T>(defaultValue: T): SolidContext<T> => ({
    id: Symbol('ultimate.ui.inert-context'),
    defaultValue,
    // Inert children pass straight through: the tree is already built by the time the renderer
    // walks it, so a Provider has nothing to provide to. `useUi()` reads the request context
    // instead — see `ambientUiContext()`.
    Provider: (props) => props.children as never,
  }),

  // Every descendant is walked outside any owner, so the default value is the only value there
  // has ever been on this path — with a real Solid runtime registered too, which is why
  // `UiProvider` refuses the inert path rather than looking like it worked.
  useContext: <T>(context: SolidContext<T>): T => context.defaultValue,

  // A plain box. `createSignal` must still round-trip a write, because a component may set state
  // during its own render (a derived default), and reading back the value it just wrote is not
  // reactivity — it is assignment.
  createSignal: <T>(value: T): [Accessor<T>, Setter<T>] => {
    let current = value;
    return [
      () => current,
      (next: T) => {
        current = next;
      },
    ];
  },

  // No graph to memoize against: recomputing on read is correct and cheaper than tracking.
  createMemo: <T>(fn: () => T) => fn,

  // The one thing that MUST NOT run. Every effect in this package is DOM work — `showModal()`,
  // `addEventListener`, `IntersectionObserver` — and the server has no DOM to do it to.
  createEffect: () => {},

  onCleanup: () => {},
});
