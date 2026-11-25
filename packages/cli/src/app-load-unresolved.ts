// A module that imports what does not resolve. It was `X_CLI_UNEXPECTED`, once per module reaching
// it, with `x doctor --json` as the fix, and doctor answered "shippable": the cycle closed on itself.
// Leaf module: `output.ts` reads it for a throw outside the scan, and the scan for one inside it.

// why: a synchronous probe and read of an installed package's manifest; Bun ships no path helpers.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isJsonObject, stringField } from '@ultimat3/core';
import type { Finding } from './output';
import { hasPathSegment, isPathUnder } from './path-segments';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';

export const IMPORT_UNRESOLVED = 'X_APP_IMPORT_UNRESOLVED';

/** npm's own shape, so `@/lib/x` (a path alias) and `node:nope` are not offered to `bun add`. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*/;

/** `@scope/pkg/sub` → `@scope/pkg`, or `undefined` for what no install can resolve. */
export const installablePackage = (specifier: string): string | undefined => {
  const name = PACKAGE_NAME.exec(specifier)?.[0];
  if (name === undefined) return undefined;
  const rest = specifier.slice(name.length);
  return rest === '' || rest.startsWith('/') ? name : undefined;
};

/** Is `pkg` in a `node_modules` the referrer resolves through, as the resolver walks: up to `/`. */
const isInstalled = (pkg: string, referrer: string): boolean => {
  for (let dir = dirname(referrer); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
};

/** Whether `path` is not the app's own source: an installed package, or a linked one beside it. */
const isOutsideApp = (root: string, path: string): boolean => {
  const base = realPath(resolve(root));
  const real = realPath(path);
  return !isPathUnder(base, real) || hasPathSegment(posixRelative(base, real), 'node_modules');
};

/** `path` with its links followed, as Bun reports a referrer — or itself when it is not on disk. */
export const realPath = (path: string): string => (existsSync(path) ? realpathSync(path) : path);

/** The manifest of the package `file` belongs to: the nearest one above it that has a name. */
function ownerManifest(file: string): Readonly<Record<string, unknown>> | undefined {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = parsedObject(readFileSync(path, 'utf8'));
    if (manifest !== undefined && typeof manifest['name'] === 'string') return manifest;
  }
  return undefined;
}

/** The JSON object `text` holds, or `undefined`: a manifest half-written by an install is no answer. */
function parsedObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the package `referrer` belongs to declares `pkg`, so the install itself is incomplete. */
function declaresDependency(referrer: string, pkg: string): boolean {
  const declared = ownerManifest(referrer)?.['dependencies'];
  return isJsonObject(declared) && Object.hasOwn(declared, pkg);
}

/** An import that resolved to nothing, as the runtime reported it. */
export interface UnresolvedImport {
  readonly specifier: string;
  /** Absolute, when the runtime named it. */
  readonly referrer?: string;
  /** `referrer` is an installed package's module: no edit of the app's is in it. */
  readonly outside: boolean;
  /** The package nobody installed; absent for a path, and for a subpath of an installed one. */
  readonly pkg?: string;
  /** What is missing, as a clause: `left-pad, which is not installed`. */
  readonly missing: string;
  readonly fix: string;
}

/** The fix inside an installed package, where the app has no line to edit. */
function outsideFix(
  pkg: string | undefined,
  named: string | undefined,
  referrer: string | undefined,
): string {
  if (pkg === undefined) {
    return `bun install --force   # the installed copy lacks what it imports: reinstall it${named === undefined ? '' : `; still so: bun why ${named}, then align the two versions`}`;
  }
  // A dependency the importing package DECLARES is missing from the install, not from the app's
  // manifest: `bun add` would copy it into the app and leave the pruned install as it was.
  return referrer !== undefined && declaresDependency(referrer, pkg)
    ? `bun install --frozen-lockfile   # ${pkg} is a declared dependency of an installed package: restore it, and prune no declared dependency from an image`
    : `bun add ${quoteArg(pkg)}`;
}

/**
 * Bun's `ResolveMessage`, read through `stringField`: a caught value this process did not build. The
 * `specifier` and `referrer` are the failing import's own, however many modules were importing the
 * file that holds it, which is what makes one finding per specifier true.
 */
export function unresolvedImport(error: unknown, root: string): UnresolvedImport | undefined {
  if (stringField(error, 'code') !== 'ERR_MODULE_NOT_FOUND') return undefined;
  const specifier = stringField(error, 'specifier');
  if (specifier === undefined) return undefined;
  const referrer = stringField(error, 'referrer');
  const outside = referrer !== undefined && isOutsideApp(root, referrer);
  const where = referrer === undefined ? 'an app module' : posixRelative(root, referrer);
  const named = installablePackage(specifier);
  // Installed, and missing only the subpath: `bun add` would exit 0 and change nothing.
  const installed = named !== undefined && referrer !== undefined && isInstalled(named, referrer);
  const pkg = installed ? undefined : named;
  const edit = `grep -nF -- ${quoteArg(specifier)} ${quoteArg(where)}   # the import no file resolves: edit it`;
  const ownFix = pkg === undefined ? edit : `bun add ${quoteArg(pkg)}`;
  return {
    specifier,
    ...(referrer === undefined ? {} : { referrer }),
    outside,
    ...(pkg === undefined ? {} : { pkg }),
    missing: installed
      ? `"${specifier}", and ${String(named)} is installed with no such subpath`
      : pkg === undefined
        ? `"${specifier}", which resolves to no file`
        : `${pkg}, which is not installed`,
    fix: outside ? outsideFix(pkg, named, referrer) : ownFix,
  };
}

/** The finding as the failing import alone tells it: at the module that holds it. */
export function unresolvedImportFinding(error: unknown, root: string): Finding | undefined {
  const found = unresolvedImport(error, root);
  if (found === undefined) return undefined;
  const at = found.referrer === undefined ? undefined : posixRelative(root, found.referrer);
  // A package the app itself imports is one `bun add`, so its cause names no importer: the render
  // layer collapses findings by cause, and every importer of it is one repair.
  const appsOwnPackage = !found.outside && found.pkg !== undefined;
  return {
    code: IMPORT_UNRESOLVED,
    cause: `${appsOwnPackage ? 'an app module' : (at ?? 'an app module')} imports ${found.missing}`,
    fix: found.fix,
    ...(at === undefined ? {} : { at }),
    meta: { specifier: found.specifier },
  };
}
