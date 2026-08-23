// The module-scope slot holding the app's Solid runtime, and nothing else.
//
// Split out of `solid-adapter.ts` because of what the neighbours cost: `solid()` throws
// `runtimeMissingError`, so it imports `../errors`, which `package.json` declares side-effectful
// (`registerErrorCodes()` runs at import) and no bundler may therefore shake. An island that only
// REGISTERS the runtime paid @ultimat3/core's whole error registry for it — 5,719 B against 72 B,
// measured in `barrel-bytes.test.ts`, which is the build error behind this file existing.

import type { SolidRuntime } from './solid-adapter';

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
 * The registered runtime or `null` — read only by `solid()`, which owns the rule about what a
 * missing one MEANS. A component never reaches this: two answers to "which runtime does this
 * render get" is the split this file is careful not to become.
 */
export function registeredSolidRuntime(): SolidRuntime | null {
  return runtime;
}
