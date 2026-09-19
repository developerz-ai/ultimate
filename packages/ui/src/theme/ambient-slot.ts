// The module-scope slot holding the reader `useUi()` falls back to when no Solid runtime is
// registered — a server render. Its own module for the same reason `runtime-slot.ts` is: the
// server's reader (`ambient.ts`) reaches `@ultimat3/i18n` and `@ultimat3/time`, and a slot that
// sat beside it would put the framework catalog in every browser chunk that calls `useUi()`.
// The slot itself imports nothing.

import type { UiContextValue } from './context';

export type AmbientUiReader = () => UiContextValue;

let reader: AmbientUiReader | null = null;

/** Called once, at import, by `ambient.ts`; a browser build never reaches that module. */
export function setAmbientUiReader(next: AmbientUiReader): void {
  reader = next;
}

export function registeredAmbientUiReader(): AmbientUiReader | null {
  return reader;
}
