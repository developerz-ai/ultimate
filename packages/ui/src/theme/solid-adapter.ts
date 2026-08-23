// Solid runtime adapter: the shape of the runtime, and the ONE rule that decides which runtime a
// render gets. @ultimat3/ui imports *types* from solid-js and nothing else, so the package
// installs, typechecks, and tests with no reactive runtime present.
//
// The slot itself is `runtime-slot.ts`, not this file: `runtimeMissingError` below reaches
// `../errors`, which is side-effectful and unshakeable, so an island that only registers a runtime
// would pay the error registry for it (`barrel-bytes.test.ts`).

import type { JSX } from 'solid-js';
import { runtimeMissingError } from '../errors';
import { INERT_SOLID_RUNTIME } from './inert-runtime';
import { registeredSolidRuntime } from './runtime-slot';

export type Accessor<T> = () => T;
export type Setter<T> = (next: T) => void;

/**
 * `children` is REQUIRED, and that one keyword is what makes `setSolidRuntime(solidRuntime)`
 * compile at all. Solid's own `ContextProviderComponent` takes `FlowProps`, whose `children` is
 * required, and a function taking `children?` is not assignable to one taking `children` — so
 * `typeof import('solid-js')` did not satisfy `SolidRuntime` and the registration this package
 * documents was a type error nobody had ever compiled: it had zero non-test callers (issue #246),
 * and every test passed a hand-written fake that matched the declaration instead of the runtime.
 * `JSX.Element` already includes `undefined`, so a provider with no children still type-checks.
 */
export interface SolidContext<T> {
  readonly id: symbol;
  readonly defaultValue: T;
  readonly Provider: (props: { value: T; children: JSX.Element }) => JSX.Element;
}

/** The exact slice of solid-js the design system touches. */
export interface SolidRuntime {
  createContext<T>(defaultValue: T): SolidContext<T>;
  useContext<T>(context: SolidContext<T>): T;
  createSignal<T>(value: T): [Accessor<T>, Setter<T>];
  createMemo<T>(fn: () => T): Accessor<T>;
  createEffect(fn: () => void): void;
  onCleanup(fn: () => void): void;
}

/**
 * A DOM is the whole of the question. With one, a component that reaches for a runtime nobody
 * registered is a real bug — the theme toggle that does nothing — so it throws. Without one there
 * is no reactivity to lose: the server calls each component once, through an inert JSX factory,
 * and `INERT_SOLID_RUNTIME` is an honest account of that, not a degradation of a working path.
 *
 * The same probe `browserThemeEnv()` uses, for the same reason and with the same answer.
 */
function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export function solid(): SolidRuntime {
  const runtime = registeredSolidRuntime();
  if (runtime !== null) return runtime;
  if (hasDom()) {
    // Two lines to paste, and both are real: `x g resource` writes exactly them into the slice's
    // `*-form.island.tsx`. The line this used to hand out was `setSolidRuntime(await
    // import('solid-js'))`, which makes `mount` ASYNC for nothing — an island chunk already
    // carries Solid statically, because the same file imports `render` from `solid-js/web`.
    throw runtimeMissingError(
      'a registered Solid runtime',
      // ONE literal, never a concatenation: `fix-scan.ts` reads a single literal in this position
      // and counts anything else `unreadable`, so a fix split across `+` is a fix the gate stops
      // checking.
      "paste `import * as solidRuntime from 'solid-js';` at the top of your *.island.tsx and `setSolidRuntime(solidRuntime);` as the first line of its mount(), above render() — a server render needs none",
    );
  }
  return INERT_SOLID_RUNTIME;
}
