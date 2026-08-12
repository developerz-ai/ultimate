// Three shape rules the gate owns: one file, one job (a hard line ceiling), every workspace
// package shipping the same contract files, and every published package's tarball matching what
// its manifest promises. All report findings — a shape rule that is only written down is not a
// rule (axiom 3).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './output';
import { eachSourceFile, isGenerated } from './source-files';

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
    if (isGenerated(path)) continue;
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
 * (`@ultimat3/core`'s `frameworkVersion()`, the CLI's `loadVersion()`, every dependency `x new` pins).
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
  /** The manifest's `files`, verbatim — what the tarball promises to carry. */
  readonly files: readonly string[];
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

/**
 * The exclusion every published package carries. Exact, not "some pattern that happens to match
 * tests": a second spelling of one rule is the drift the gate exists to prevent.
 */
export const TEST_EXCLUSION = '!src/**/*.test.ts';

export const missingPublishedFileFinding = (dir: string, entry: string): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/package.json ships "${entry}" in "files", but packages/${dir}/${entry} does not exist`,
  fix: `add packages/${dir}/${entry}, or drop "${entry}" from "files" in packages/${dir}/package.json`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/package.json`,
});

export const publishesTestsFinding = (dir: string): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/package.json does not exclude ${TEST_EXCLUSION} from "files"`,
  fix: `add "${TEST_EXCLUSION}" to "files" in packages/${dir}/package.json, after "src"`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/package.json`,
});

/**
 * Emit that is authored source anyway, so the sweep may not take it. One list, read by the check
 * and written into the `fix:` that performs it — a second spelling is a command that deletes a file
 * the gate then reports as missing.
 */
export const ARTIFACT_ALLOWLIST: readonly string[] = ['packages/ui/src/scss.d.ts'];

/** `-name` matches the same suffixes the check globs; `! -path` spares each allowlisted file. */
const SWEEP_PREDICATE = [
  `\\( -name '*.d.ts' -o -name '*.js' -o -name '*.map' \\)`,
  ...ARTIFACT_ALLOWLIST.map((path) => `! -path '${path}'`),
].join(' ');

export const buildArtifactsFinding = (dir: string, count: number): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/src/ contains ${count} build artifacts (.d.ts, .js, .map files)`,
  fix: `find packages/${dir}/src ${SWEEP_PREDICATE} -delete`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/src/`,
});

/**
 * Reported apart from the exclusion above so the `fix:` stays runnable. Told to "add an entry to
 * `files`" when there is no `files` at all, an author edits a key that is not there — and axiom 4
 * is that an error names the exact fix, not an approximate one.
 */
export const noFilesAllowlistFinding = (dir: string): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/package.json publishes with no "files" allowlist, so the tarball carries whatever is in the directory`,
  fix: `add "files": ["src", "${TEST_EXCLUSION}", "README.md", "LICENSE"] to packages/${dir}/package.json`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/package.json`,
});

/**
 * What the tarball actually carries, as a build error rather than a paragraph in PUBLISHING.md.
 *
 * npm **silently skips** a `files` entry with no file behind it, so a manifest can promise a
 * `LICENSE` it never ships and publish green: all 28 packages declared `"license": "MIT"`, named
 * `LICENSE` in `files`, and shipped the grant in none of them. It reads as correct in review, in
 * `npm publish`, and on the package page — right up to the point somebody needs the license text
 * that is not in the artifact they received. And a publish cannot be undone.
 *
 * The second half is `src` sweeping in every `*.test.ts` beside it. Tests are the framework's own,
 * they run against a preloaded frozen clock and a sealed network, and a consumer's test runner
 * collecting them is a failure nobody asked for — 393 files, over half of `@ultimat3/cli`'s
 * tarball.
 *
 * Private packages are exempt: a generated app's `packages/*` never reach a registry, carry no
 * `files` and need no license of their own.
 */
export function checkPublishShape(root: string, manifests: readonly ManifestFacts[]): Finding[] {
  const findings: Finding[] = [];
  for (const manifest of manifests) {
    if (manifest.private) continue;
    if (manifest.files.length === 0) {
      findings.push(noFilesAllowlistFinding(manifest.dir));
      continue;
    }
    for (const entry of manifest.files) {
      // A negation removes files; only a positive literal can promise one that is not there.
      if (entry.startsWith('!') || /[*?[\]]/.test(entry)) continue;
      if (existsSync(join(root, 'packages', manifest.dir, entry))) continue;
      findings.push(missingPublishedFileFinding(manifest.dir, entry));
    }
    if (!manifest.files.includes(TEST_EXCLUSION)) {
      findings.push(publishesTestsFinding(manifest.dir));
    }
  }
  return findings;
}

export function filesOf(manifest: unknown): readonly string[] {
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as {
    files?: unknown;
  };
  return Array.isArray(record.files)
    ? record.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
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
  const allowlisted = new Set(ARTIFACT_ALLOWLIST);
  for (const dir of await workspacePackages(root)) {
    for (const file of PACKAGE_FILES) {
      if (existsSync(join(root, 'packages', dir, file))) continue;
      findings.push(missingFileFinding(dir, file, scaffolder));
    }
    // `src/` is authored source only; anything a build emitted there ships in the tarball too.
    const artifacts: string[] = [];
    for await (const path of new Bun.Glob('src/**/*.{d.ts,js,map}').scan({
      cwd: join(root, 'packages', dir),
      absolute: false,
    })) {
      if (!allowlisted.has(join('packages', dir, path))) artifacts.push(path);
    }
    if (artifacts.length > 0) {
      findings.push(buildArtifactsFinding(dir, artifacts.length));
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
      files: filesOf(manifest),
    });
  }
  return [...findings, ...checkLockstep(facts), ...checkPublishShape(root, facts)];
}
