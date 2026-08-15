// Solid runtime adapter. @ultimat3/ui imports *types* from solid-js and nothing
// else, so the package installs, typechecks, and tests with no reactive runtime
// present. The CLIENT entry registers the real one once; a server render gets the inert one.

import type { JSX } from 'solid-js';
import { runtimeMissingError } from '../errors';
import { INERT_SOLID_RUNTIME } from './inert-runtime';

export type Accessor<T> = () => T;
export type Setter<T> = (next: T) => void;

export interface SolidContext<T> {
  readonly id: symbol;
  readonly defaultValue: T;
  readonly Provider: (props: { value: T; children?: JSX.Element }) => JSX.Element;
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

let runtime: SolidRuntime | null = null;

/** Register once, in the app entry, before the first render. */
export function setSolidRuntime(next: SolidRuntime): void {
  runtime = next;
}

export function hasSolidRuntime(): boolean {
  return runtime !== null;
}

/** For tests: drop the registration so cases stay independent. */
export function clearSolidRuntime(): void {
  runtime = null;
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
  if (runtime !== null) return runtime;
  if (hasDom()) {
    throw runtimeMissingError(
      'a registered Solid runtime',
      "add setSolidRuntime(await import('solid-js')) to the CLIENT entry before render — a server render needs none",
    );
  }
  return INERT_SOLID_RUNTIME;
}
