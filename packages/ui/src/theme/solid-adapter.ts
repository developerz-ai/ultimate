// Solid runtime adapter. @ultimat3/ui imports *types* from solid-js and nothing
// else, so the package installs, typechecks, and tests with no reactive runtime
// present. The app entry (or @ultimat3/render) registers the real one once.

import type { JSX } from 'solid-js';
import { runtimeMissingError } from '../errors';

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

export function solid(): SolidRuntime {
  if (runtime === null) {
    throw runtimeMissingError(
      'a registered Solid runtime',
      "add setSolidRuntime(await import('solid-js')) to the app entry before render",
    );
  }
  return runtime;
}
