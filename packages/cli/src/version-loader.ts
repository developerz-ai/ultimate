// The CLI's own version, read lazily. Lazily because `registry.ts` evaluates every command module
// at import, and a top-level cross-package import from there is what broke module initialisation
// order before — so the value is fetched at the call, not at module scope.

// Bun has no path-join primitive; `import.meta.dir` is this module's directory in both the
// checked-out `src/` layout and the published `dist/` one, each one level below the package root.
import { resolve } from 'node:path';
import { readPackageVersion } from '@ultimat3/core';

/** `@ultimat3/cli`'s own manifest — released in lockstep with the rest of `@ultimat3/*`. */
export const CLI_MANIFEST = resolve(import.meta.dir, '..', 'package.json');

/** Throws `X_INVARIANT` if this package shipped without a version — see `readPackageVersion`. */
export function loadVersion(): string {
  return readPackageVersion(CLI_MANIFEST);
}
