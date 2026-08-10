// Two shape rules the gate owns: one file, one job (a hard line ceiling), and every workspace
// package shipping the same contract files. Both report findings — a shape rule that is only
// written down is not a rule (axiom 3).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './output';
import { eachSourceFile } from './source-files';

export const LINE_CEILING = 500;

export const PACKAGE_FILES = ['README.md', 'CLAUDE.md', 'tsconfig.json', 'src/index.ts'] as const;

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

export const tooLongFinding = (path: string, lines: number): Finding => ({
  code: 'X_FILE_TOO_LONG',
  cause: `${path} is ${lines} lines, over the ${LINE_CEILING} line ceiling`,
  fix: `split ${path}: one file, one responsibility`,
  docs: docs('X_FILE_TOO_LONG'),
  at: path,
});

/**
 * A trailing newline terminates the last line, it does not start another one. Counting the split
 * parts instead made the real ceiling 499 and reported every count one too high — every correctly
 * formatted file here ends with a newline, which is exactly the case that was wrong.
 */
export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Files are the unit of review: one file, one job, hard ceiling 500 lines. */
export async function checkFileSizes(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for await (const path of eachSourceFile(root)) {
    const lines = countLines(await Bun.file(join(root, path)).text());
    if (lines > LINE_CEILING) findings.push(tooLongFinding(path, lines));
  }
  return findings;
}

export const missingFileFinding = (dir: string, file: string, scaffolder: boolean): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir} has no ${file}`,
  fix: scaffolder
    ? `bun run scripts/new-package.ts ${dir} --only ${file}`
    : `add packages/${dir}/${file}, shaped like the one in a sibling package`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/${file}`,
});

/**
 * A published package reports its own version by reading its own `package.json` at runtime
 * (`@ultimat3/core`'s `FRAMEWORK_VERSION`, the CLI's `CLI_VERSION`, every dependency `x new` pins).
 * A manifest with no semver `version` therefore breaks the MCP handshake and every scaffold — so
 * the gate refuses the publish here, where the fix is one line, rather than at someone's install.
 */
export const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

export const badVersionFinding = (dir: string, found: unknown): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/package.json has no semver "version" (found ${JSON.stringify(found)})`,
  fix: `set a semver "version" in packages/${dir}/package.json, then: bun run verify`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/package.json`,
});

/**
 * What the lockstep rule needs from one manifest. Read once, in `checkPackageShape`, so the gate
 * opens each package.json a single time.
 */
export interface ManifestFacts {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  /** Every `@ultimat3/*` pin npm publishes and the range it is pinned to, in declaration order. */
  readonly frameworkDeps: readonly (readonly [name: string, range: string])[];
}

/**
 * The manifest fields a published package carries to the registry. `devDependencies` is absent
 * deliberately: npm does not install it for a consumer, so a stale one there cannot break anybody's
 * install — while a stale `peerDependencies` or `optionalDependencies` pin resolves at install time
 * exactly like `dependencies` does, and skipping them let skew reach the registry unreported.
 */
export const PUBLISHED_DEP_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export const versionSkewFinding = (dir: string, found: string, expected: string): Finding => ({
  code: 'X_RELEASE_VERSION_SKEW',
  cause: `packages/${dir} is at ${found}, not the lockstep version ${expected}`,
  fix: `bun run scripts/release.ts --version ${expected}`,
  docs: docs('X_RELEASE_VERSION_SKEW'),
  at: `packages/${dir}/package.json`,
});

export const pinSkewFinding = (
  dir: string,
  dep: string,
  range: string,
  expected: string,
): Finding => ({
  code: 'X_RELEASE_VERSION_SKEW',
  cause: `packages/${dir} pins ${dep} at ${range}, not the lockstep version ${expected}`,
  fix: `bun run scripts/release.ts --version ${expected}`,
  docs: docs('X_RELEASE_VERSION_SKEW'),
  at: `packages/${dir}/package.json`,
});

/**
 * Lockstep versioning, as a build error rather than a paragraph in PUBLISHING.md. Two ways a
 * release breaks silently: a package left behind at the old version, and — the one that actually
 * shipped — every package's own version bumped while its sibling pins stayed put, so
 * `@ultimat3/jobs@1.0.0` names `@ultimat3/core@0.0.1`, a version that is not on the registry.
 * npm resolves that at somebody else's install, which is far too late.
 *
 * Private packages are exempt on both counts: a generated app's `packages/*` are private, carry
 * their own version line and depend on the framework by caret range.
 */
export function checkLockstep(manifests: readonly ManifestFacts[]): readonly Finding[] {
  const published = manifests.filter((manifest) => !manifest.private);
  // `core` is tier 0 and everything depends on it, so it is the version the rest must match.
  const anchor = published.find((manifest) => manifest.dir === 'core') ?? published[0];
  if (anchor === undefined) return [];
  const findings: Finding[] = [];
  for (const manifest of published) {
    if (manifest.version !== anchor.version) {
      findings.push(versionSkewFinding(manifest.dir, manifest.version, anchor.version));
    }
    for (const [dep, range] of manifest.frameworkDeps) {
      if (range !== anchor.version) {
        findings.push(pinSkewFinding(manifest.dir, dep, range, anchor.version));
      }
    }
  }
  return findings;
}

export function frameworkDepsOf(manifest: unknown): ManifestFacts['frameworkDeps'] {
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as Record<
    string,
    unknown
  >;
  return PUBLISHED_DEP_FIELDS.flatMap((field) => {
    const deps = record[field];
    if (typeof deps !== 'object' || deps === null) return [];
    return Object.entries(deps).flatMap(([name, range]) =>
      name.startsWith('@ultimat3/') && typeof range === 'string' ? [[name, range] as const] : [],
    );
  });
}

export async function workspacePackages(root: string): Promise<readonly string[]> {
  const dirs: string[] = [];
  for await (const path of new Bun.Glob('packages/*/package.json').scan({
    cwd: root,
    absolute: false,
  })) {
    const dir = path.split('/')[1];
    if (dir !== undefined) dirs.push(dir);
  }
  return dirs.sort();
}

export const hasWorkspacePackages = async (root: string): Promise<boolean> =>
  (await workspacePackages(root)).length > 0;

/** Every package ships the same contract files; a missing one is a build error, not a chore. */
export async function checkPackageShape(root: string): Promise<readonly Finding[]> {
  const scaffolder = existsSync(join(root, 'scripts', 'new-package.ts'));
  const findings: Finding[] = [];
  const facts: ManifestFacts[] = [];
  for (const dir of await workspacePackages(root)) {
    for (const file of PACKAGE_FILES) {
      if (existsSync(join(root, 'packages', dir, file))) continue;
      findings.push(missingFileFinding(dir, file, scaffolder));
    }
    const manifest: unknown = await Bun.file(join(root, 'packages', dir, 'package.json')).json();
    const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as {
      name?: unknown;
      version?: unknown;
      private?: unknown;
    };
    const version = record.version;
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      findings.push(badVersionFinding(dir, version));
      continue;
    }
    facts.push({
      dir,
      name: typeof record.name === 'string' ? record.name : `@ultimat3/${dir}`,
      version,
      private: record.private === true,
      frameworkDeps: frameworkDepsOf(manifest),
    });
  }
  return [...findings, ...checkLockstep(facts)];
}
