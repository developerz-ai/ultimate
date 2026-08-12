// The CLI's own version, read lazily. Lazily because `registry.ts` evaluates every command module
// at import, and a top-level cross-package import from there is what broke module initialisation
// order before — so the value is fetched at the call, not at module scope.

// Bun has no path-join primitive; `import.meta.dir` is this module's directory in both the
// checked-out `src/` layout and the published `dist/` one, each one level below the package root.
import { resolve } from 'node:path';
import { resolveVersion } from '@ultimat3/core';

/** `@ultimat3/cli`'s own manifest — released in lockstep with the rest of `@ultimat3/*`. */
export const CLI_MANIFEST = resolve(import.meta.dir, '..', 'package.json');

// Replaced with a string literal by `bun build --define ULTIMATE_FRAMEWORK_VERSION='"1.2.3"'`
// (`binaryArgs` in `cmd-build.ts`), and declared by nothing at runtime — hence the `typeof` guard
// below. An unbundled process must see `undefined` here, not a `ReferenceError`.
declare const ULTIMATE_FRAMEWORK_VERSION: string | undefined;

/**
 * Manifest first, build define second — the same fallback `frameworkVersion()` takes, through the
 * same `resolveVersion`, off deliberately the same define. A compiled single-file executable
 * carries no `package.json`, so without the fallback `x --version` inside one answers `X_INVARIANT`
 * for a version the build already knew; and a second define name would be a second version fact to
 * hold in step, when `@ultimat3/cli` and `@ultimat3/core` ship one version, one commit, one tag.
 *
 * Throws `X_INVARIANT` if neither source answers — a publish with no version, or a `--compile` that
 * skipped the define. See `resolveVersion`.
 */
export function loadVersion(): string {
  return resolveVersion(
    CLI_MANIFEST,
    typeof ULTIMATE_FRAMEWORK_VERSION === 'string' ? ULTIMATE_FRAMEWORK_VERSION : undefined,
  );
}
