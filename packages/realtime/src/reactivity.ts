// What a hook renders through: THIS island bundle's signal factory. Module scope on purpose —
// every island carries its own solid-js, so a signal must come from the bundle whose effects read
// it, while the store behind it is the page's (`page-store.ts`). The island bootstrap installs it.

import type { SignalFactory } from './client-contract';
import { RealtimeUninstalledError } from './page-errors';
import { pageRealtime, type SyncTarget } from './page-store';

export interface RealtimeInstall {
  /** `createSignal` from this island's solid-js, narrowed to two functions. */
  readonly signal: SignalFactory;
  /** Where the page's socket dials. Omitted by an island that holds no live hook. */
  readonly sync?: SyncTarget;
}

let installed: SignalFactory | undefined;

/**
 * Called by the island bootstrap `x build` prepends — never by an island's own code. Per bundle
 * for the signal, per page for the sync target (the first one given wins; every island on a page
 * was rendered by one server and names one node).
 */
export function installRealtime(install: RealtimeInstall): void {
  installed = install.signal;
  const page = pageRealtime();
  if (install.sync !== undefined && page.sync === undefined) page.sync = install.sync;
}

/**
 * A DOM is the whole question, the same probe and the same words as `@ultimat3/ui`'s `solid()`:
 * with one, a hook that finds nothing installed is a real bug; without one it is a server render.
 */
export function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * A signal that never changes, because nothing on the server can change it: one render, one pass.
 * The setter is kept so a caller reads its own write back — a signal that swallowed writes would
 * be a different lie.
 */
const inertSignal: SignalFactory = <T>(initial: T): [() => T, (next: T) => void] => {
  let held = initial;
  return [
    (): T => held,
    (next: T): void => {
      held = next;
    },
  ];
};

/** The factory `hook` renders through: this bundle's, or the inert one on a server render. */
export function signalFor(hook: string): SignalFactory {
  if (installed !== undefined) return installed;
  if (hasDom()) throw new RealtimeUninstalledError({ hook });
  return inertSignal;
}

/**
 * A server render: nothing installed and no DOM. A hook answers the honest server state and never
 * touches the page state — on a server that would be ONE store shared by every request.
 */
export function isServerRender(): boolean {
  return installed === undefined && !hasDom();
}

/** For tests: forget this bundle's install so cases stay independent. */
export function uninstallRealtime(): void {
  installed = undefined;
}
