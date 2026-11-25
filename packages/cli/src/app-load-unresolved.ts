// A module that imports what does not resolve. It was `X_CLI_UNEXPECTED`, once per module reaching
// it, with `x doctor --json` as the fix, and doctor answered "shippable": the cycle closed on itself.
// Leaf module: `output.ts` reads it for a throw outside the scan, and the scan for one inside it.

// why: a synchronous probe and read of an installed package's manifest; Bun ships no path helpers.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

/**
 * Whose module it is. `installed`: under a `node_modules`, so an install is what writes it. `linked`:
 * neither the app's nor installed — a checkout a link reaches, which its owner edits and installs.
 */
type Place = 'app' | 'installed' | 'linked';

function placeOf(root: string, path: string): Place {
  const base = realPath(resolve(root));
  const real = realPath(path);
  // Relative to the app, so one that itself sits under some `node_modules` is still an app.
  if (hasPathSegment(posixRelative(base, real), 'node_modules')) return 'installed';
  return isPathUnder(base, real) ? 'app' : 'linked';
}

/**
 * `path` with its links followed, as Bun reports a referrer — or itself when they cannot be: this
 * runs while a failure is being reported, over a tree an install may be rewriting.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The package a module belongs to. `manifest` is absent when there is none that can be read. */
interface Owner {
  readonly dir: string;
  readonly manifest?: Readonly<Record<string, unknown>>;
}

/** The nearest named manifest above `file`, and never one above the package's own directory. */
function ownerOf(file: string): Owner {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = readManifest(join(dir, 'package.json'));
    if (manifest === 'unreadable') return { dir };
    if (manifest !== 'absent' && typeof manifest['name'] === 'string') return { dir, manifest };
    const above = dirname(dir);
    if (above === dir || basename(above) === 'node_modules') return { dir };
  }
}

/**
 * Best effort by design: the caller is reporting a failed import, and a manifest an install is
 * replacing — gone, half-written, a directory — must not become the failure that is reported.
 */
function readManifest(path: string): Readonly<Record<string, unknown>> | 'absent' | 'unreadable' {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isJsonObject(parsed) ? parsed : 'unreadable';
  } catch (error) {
    return stringField(error, 'code') === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/** An import that resolved to nothing, as the runtime reported it. */
export interface UnresolvedImport {
  readonly specifier: string;
  /** Absolute, when the runtime named it. */
  readonly referrer?: string;
  /** `referrer` is a package's module, installed or linked: not a file of the app's. */
  readonly outside: boolean;
  /** The package nobody installed; absent for a path, and for a subpath of an installed one. */
  readonly pkg?: string;
  /** What is missing, as a clause: `left-pad, which is not installed`. */
  readonly missing: string;
  readonly fix: string;
}

/** The line that shows the import to edit, in the file that holds it. */
const editFix = (specifier: string, where: string): string =>
  `grep -nF -- ${quoteArg(specifier)} ${quoteArg(where)}   # the import no file resolves: edit it`;

const declares = (owner: Owner, pkg: string): boolean => {
  const declared = owner.manifest?.['dependencies'];
  return isJsonObject(declared) && Object.hasOwn(declared, pkg);
};

/**
 * The directory whose install wrote `file`, when that is not the app's: the one above the outermost
 * `node_modules` on the way there — a linked checkout's own. `undefined` is the app's install,
 * wherever its linker put the package: in the app, a workspace of it, or the workspace root above.
 */
function foreignInstall(root: string, file: string): string | undefined {
  const base = realPath(resolve(root));
  const parts = posixRelative(base, realPath(file)).split('/');
  const dir = resolve(base, parts.slice(0, parts.indexOf('node_modules')).join('/'));
  const ours = dir === base || isPathUnder(base, dir) || isPathUnder(dir, base);
  return ours ? undefined : dir;
}

/** Inside an installed package: nobody has a line to edit, and an install is what writes it. */
function installedFix(
  root: string,
  referrer: string,
  named: string | undefined,
  pkg: string | undefined,
): string {
  const owner = ownerOf(referrer);
  const foreign = foreignInstall(root, referrer);
  const cwd = foreign === undefined ? '' : ` --cwd ${quoteArg(foreign)}`;
  if (pkg === undefined || owner.manifest === undefined) {
    const why = `bun why ${String(named)}${foreign === undefined ? '' : ' there'}`;
    return `bun install --force${cwd}   # the installed copy lacks what it imports: reinstall it${named === undefined ? '' : `; still so: ${why}, then align the two versions`}`;
  }
  if (!declares(owner, pkg)) return `bun add ${quoteArg(pkg)}${cwd}`;
  // A dependency the importing package DECLARES is missing from the install, not from the app's
  // manifest: `bun add` would copy it into the app and leave the pruned install as it was.
  return foreign === undefined
    ? `bun install --frozen-lockfile   # ${pkg} is a declared dependency of an installed package: restore it, and prune no declared dependency from an image`
    : `bun install${cwd}   # ${pkg} is a declared dependency of a package installed there: restore it`;
}

/**
 * Inside a linked checkout: no install of the app's writes it, and nothing installed in the app
 * resolves from it — a module resolves from its real path.
 */
function linkedFix(
  specifier: string,
  where: string,
  referrer: string,
  pkg: string | undefined,
): string {
  const owner = ownerOf(realPath(referrer));
  // No manifest to install from: what is left is the import itself.
  if (pkg === undefined || owner.manifest === undefined) return editFix(specifier, where);
  return declares(owner, pkg)
    ? `bun install --cwd ${quoteArg(owner.dir)}`
    : `bun add ${quoteArg(pkg)} --cwd ${quoteArg(owner.dir)}`;
}

/**
 * Bun's `ResolveMessage`, read through `stringField`: a caught value this process did not build. The
 * `specifier` and `referrer` are the failing import's own, however many modules were importing the
 * file that holds it.
 */
export function unresolvedImport(error: unknown, root: string): UnresolvedImport | undefined {
  if (stringField(error, 'code') !== 'ERR_MODULE_NOT_FOUND') return undefined;
  const specifier = stringField(error, 'specifier');
  if (specifier === undefined) return undefined;
  const referrer = stringField(error, 'referrer');
  const place = referrer === undefined ? 'app' : placeOf(root, referrer);
  const where = referrer === undefined ? 'an app module' : posixRelative(root, referrer);
  const named = installablePackage(specifier);
  // Installed, and missing only the subpath: `bun add` would exit 0 and change nothing.
  const installed = named !== undefined && referrer !== undefined && isInstalled(named, referrer);
  const pkg = installed ? undefined : named;
  const ownFix = pkg === undefined ? editFix(specifier, where) : `bun add ${quoteArg(pkg)}`;
  const fixAt = (from: string): string =>
    place === 'linked'
      ? linkedFix(specifier, where, from, pkg)
      : place === 'installed'
        ? installedFix(root, from, named, pkg)
        : ownFix;
  return {
    specifier,
    ...(referrer === undefined ? {} : { referrer }),
    outside: place !== 'app',
    ...(pkg === undefined ? {} : { pkg }),
    missing: installed
      ? `"${specifier}", and ${String(named)} is installed with no such subpath`
      : pkg === undefined
        ? `"${specifier}", which resolves to no file`
        : `${pkg}, which is not installed`,
    fix: referrer === undefined ? ownFix : fixAt(referrer),
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
