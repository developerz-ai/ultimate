// The one version string the framework reports — MCP `serverInfo`, `x --version`, the deps a
// scaffold pins. Read from this package's OWN package.json, never the workspace root: the root
// manifest is `private` and carries no `version`, and after `npm install` a walk above the package
// lands in `node_modules/` where there is no manifest at all. Both mistakes fail silently.

import { existsSync, readFileSync } from 'node:fs';
// Bun has no path-join primitive; `import.meta.dir` is the module's own directory in both the
// checked-out `src/` layout and the published `dist/` one, each exactly one level below the
// package root.
import { resolve } from 'node:path';
import { UltimateError } from './errors';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

/** `@ultimat3/core`'s own manifest — the only file that can answer what version shipped. */
export const VERSION_MANIFEST = resolve(import.meta.dir, '..', 'package.json');

/**
 * The bundler define that carries the version into a build with no manifest to read.
 * `x build --target binary` passes it (`binaryArgs` in `@ultimat3/cli`); the name is declared here
 * so the flag that writes it and the read below cannot drift.
 */
export const VERSION_DEFINE = 'ULTIMATE_FRAMEWORK_VERSION';

// Replaced with a string literal by `bun build --define ULTIMATE_FRAMEWORK_VERSION='"1.2.3"'`, and
// declared by nothing at runtime — which is why the read is `typeof`-guarded. An unbundled process
// must see `undefined` here, not a `ReferenceError`.
declare const ULTIMATE_FRAMEWORK_VERSION: string | undefined;

/**
 * A package with no readable version is a broken publish, not a runtime condition to degrade
 * through: an `undefined` version poisons the MCP handshake and every dependency a scaffold pins,
 * and does it quietly. Fail where the fix is a release-script change.
 */
export function readPackageVersion(manifestPath: string): string {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new UltimateError({
      code: 'X_INVARIANT',
      cause: `${manifestPath} has no valid semver "version" field (found ${JSON.stringify(version)})`,
      fix: `set a semver "version" in ${manifestPath}, then re-run: bun run verify`,
    });
  }
  return version;
}

/**
 * Manifest first, build define second, throw last.
 *
 * A single-file executable carries no `package.json`, so a *missing* manifest is the one absence
 * that is not a broken publish — it falls through to the define. A manifest that exists and
 * declares no semver still throws, because that is the broken publish `readPackageVersion` was
 * written for, and a define must not paper over it. Pure and exported so the compiled-binary case
 * is a unit test rather than a `bun build --compile` nobody runs.
 */
export function resolveVersion(manifestPath: string, defined: string | undefined): string {
  if (existsSync(manifestPath)) return readPackageVersion(manifestPath);
  if (defined !== undefined && SEMVER.test(defined)) return defined;
  throw new UltimateError({
    code: 'X_INVARIANT',
    cause: `no manifest at ${manifestPath} and no valid ${VERSION_DEFINE} define (found ${JSON.stringify(defined)}) — only the builder that passes the define produces a bootable binary`,
    fix: `x build --target binary`,
  });
}

let resolved: string | undefined;

/**
 * The framework's version, resolved on first call and cached for every call after.
 *
 * Lazy is the whole point. As a module-scope constant the read ran before `main` in every process
 * that imported core, so `x build --target binary` produced an artifact that threw at import
 * before any role started — the artifact compiled and could never boot.
 */
export function frameworkVersion(): string {
  if (resolved === undefined) {
    resolved = resolveVersion(
      VERSION_MANIFEST,
      typeof ULTIMATE_FRAMEWORK_VERSION === 'string' ? ULTIMATE_FRAMEWORK_VERSION : undefined,
    );
  }
  return resolved;
}
