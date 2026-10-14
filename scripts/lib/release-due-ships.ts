// Does a changed path reach a published tarball? The half of `scripts/release-due.ts` that reads
// each publishable package's own `files` field, so "ships" is what npm packs, never a guess.

// why: Bun ships no path API, and each manifest is read by its host-separator path.
import { join } from 'node:path';
import type { Workspace } from './workspaces';

/** One publishable workspace and its `files` field (`undefined`: none declared, npm packs all). */
export interface PackageFiles {
  readonly dir: string;
  readonly files: readonly string[] | undefined;
}

/**
 * Packed, and still no reason to release: prose (`README.md`, `CLAUDE.md` — a typo fix is not a
 * version), tests (`.test.tsx` is not in any `files` negation today, and a test is never an API)
 * and fixtures. Read relative to the package, so a directory named `fixtures` anywhere counts.
 */
const NEVER_A_RELEASE: readonly RegExp[] = [
  /\.md$/i,
  /\.test\.tsx?$/,
  /-fixture\.tsx?$/,
  /(?:^|\/)(?:__)?fixtures?(?:__)?\//,
];

const matchesEntry = (inner: string, entry: string): boolean =>
  inner === entry || inner.startsWith(`${entry}/`) || new Bun.Glob(entry).match(inner);

/** npm's reading of `files`: any include matches and no `!` negation does. */
export function inTarball(inner: string, files: readonly string[] | undefined): boolean {
  if (files === undefined) return true;
  const included = files.some((entry) => !entry.startsWith('!') && matchesEntry(inner, entry));
  const negated = files.some(
    (entry) => entry.startsWith('!') && matchesEntry(inner, entry.slice(1)),
  );
  return included && !negated;
}

/**
 * The package directory a repo path ships in, or `undefined`. `package.json` always ships — npm
 * packs it whatever `files` says, and a dependency bump in one is a change every installer gets.
 * A path under a private workspace, or outside `packages/`, never does.
 */
export function shippingPackage(
  path: string,
  packages: ReadonlyMap<string, PackageFiles>,
): string | undefined {
  const match = /^packages\/([^/]+)\/(.+)$/.exec(path);
  const pkg = packages.get(match?.[1] ?? '');
  const inner = match?.[2];
  if (pkg === undefined || inner === undefined) return undefined;
  if (inner === 'package.json') return pkg.dir;
  if (NEVER_A_RELEASE.some((pattern) => pattern.test(inner))) return undefined;
  return inTarball(inner, pkg.files) ? pkg.dir : undefined;
}

/** `files` parsed from `unknown`: an array of strings, or `undefined` for anything else. */
const filesOf = (manifest: unknown): readonly string[] | undefined => {
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const files: unknown = Object.hasOwn(manifest, 'files')
    ? (manifest as Record<string, unknown>)['files']
    : undefined;
  return Array.isArray(files) && files.every((entry) => typeof entry === 'string')
    ? (files as readonly string[])
    : undefined;
};

/** Every publishable workspace's `files`, keyed by its directory under `packages/`. */
export async function packageFiles(
  publishable: readonly Workspace[],
): Promise<ReadonlyMap<string, PackageFiles>> {
  const out = new Map<string, PackageFiles>();
  for (const workspace of publishable) {
    // `listWorkspaces` already refused an unreadable manifest, so this read cannot be the first.
    const manifest: unknown = await Bun.file(join(workspace.path, 'package.json')).json();
    out.set(workspace.dir, { dir: workspace.dir, files: filesOf(manifest) });
  }
  return out;
}
