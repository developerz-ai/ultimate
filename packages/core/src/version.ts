// The one version string the framework reports — MCP `serverInfo`, `x --version`, the deps a
// scaffold pins. Read from this package's OWN package.json, never the workspace root: the root
// manifest is `private` and carries no `version`, and after `npm install` a walk above the package
// lands in `node_modules/` where there is no manifest at all. Both mistakes fail silently.

import { readFileSync } from 'node:fs';
// Bun has no path-join primitive; `import.meta.dir` is the module's own directory in both the
// checked-out `src/` layout and the published `dist/` one, each exactly one level below the
// package root.
import { resolve } from 'node:path';
import { UltimateError } from './errors';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

/** `@ultimat3/core`'s own manifest — the only file that can answer what version shipped. */
export const VERSION_MANIFEST = resolve(import.meta.dir, '..', 'package.json');

/**
 * A package with no readable version is a broken publish, not a runtime condition to degrade
 * through: an `undefined` version poisons the MCP handshake and every dependency a scaffold pins,
 * and does it quietly. Fail at import, where the fix is a release-script change.
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

export const FRAMEWORK_VERSION: string = readPackageVersion(VERSION_MANIFEST);
