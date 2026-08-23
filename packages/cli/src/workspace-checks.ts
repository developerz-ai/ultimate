// Four shape rules the gate owns: one file, one job (a hard line ceiling on REVIEWABLE LOGIC),
// every workspace package shipping the same contract files, every published package's tarball
// matching what its manifest promises, and every published package being in the root build graph.
// All report findings — a shape rule that is only written down is not a rule (axiom 3).
//
// The ceiling exempts a pure re-export manifest, and only that. Such a file has one job by
// construction and its length is a function of the package's API size rather than of its
// complexity: `@ultimat3/core`'s `src/index.ts` reached 514 lines with 513 statements and not one
// of them logic, so the ceiling had stopped protecting anything and started refusing every new
// public subject. `isReExportManifest` is the whole carve-out — one statement of logic in such a
// file re-arms the ceiling on the same save, which is what keeps it from being a hole.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_DOCS_URL, renderCauseValue } from '@ultimat3/core';
import type { Finding } from './output';
import { isReExportManifest } from './reexport-manifest';
import { eachSourceFile, isGenerated } from './source-files';
import { checkRootReferences } from './tsconfig-references';

export const LINE_CEILING = 500;

export const PACKAGE_FILES = ['README.md', 'CLAUDE.md', 'tsconfig.json', 'src/index.ts'] as const;

export const tooLongFinding = (path: string, lines: number): Finding => ({
  code: 'X_FILE_TOO_LONG',
  cause: `${path} is ${lines} lines, over the ${LINE_CEILING} line ceiling`,
  fix: `split ${path}: one file, one responsibility`,
  docs: ERROR_DOCS_URL,
  at: path,
});

/**
 * A trailing newline terminates the last line, it does not start another one. Counting the split
 * parts instead made the real ceiling 499 and reported every count one too high — every correctly
 * formatted file here ends with a newline, which is exactly the case that was wrong.
 */
export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/**
 * Files are the unit of review: one file, one job, hard ceiling 500 lines of reviewable logic.
 *
 * The source is read before the count is judged rather than after, because the exemption is a
 * question about CONTENTS: a 3,000-line file of re-exports is one job and a 501-line file with one
 * statement of logic in it is not, and only reading tells them apart.
 */
export async function checkFileSizes(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for await (const path of eachSourceFile(root)) {
    if (isGenerated(path)) continue;
    const source = await Bun.file(join(root, path)).text();
    const lines = countLines(source);
    if (lines <= LINE_CEILING || isReExportManifest(source)) continue;
    findings.push(tooLongFinding(path, lines));
  }
  return findings;
}

export const missingFileFinding = (dir: string, file: string, scaffolder: boolean): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir} has no ${file}`,
  fix: scaffolder
    ? `bun run scripts/new-package.ts ${dir} --only ${file}`
    : `add packages/${dir}/${file}, shaped like the one in a sibling package`,
  docs: ERROR_DOCS_URL,
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
  // `found` is whatever the manifest's `version` parsed to — an app's JSON, not the gate's value.
  // Bare `JSON.stringify` throws on a bigint and a cycle and runs any `toJSON`, which would replace
  // this finding with a TypeError from inside the gate.
  cause: `packages/${dir}/package.json has no semver "version" (found ${renderCauseValue(found)})`,
  fix: `set a semver "version" in packages/${dir}/package.json, then: bun run verify`,
  docs: ERROR_DOCS_URL,
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
  docs: ERROR_DOCS_URL,
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
  docs: ERROR_DOCS_URL,
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
export function checkLockstep(
  manifests: readonly ManifestFacts[],
  release?: string,
): readonly Finding[] {
  const published = manifests.filter((manifest) => !manifest.private);
  // `core` is tier 0 and everything depends on it, so it is the version the rest must match.
  const internal = published.find((manifest) => manifest.dir === 'core') ?? published[0];
  // With a release version the anchor is EXTERNAL, and that is the whole point: comparing packages
  // only to each other is green in a repo where all 29 sit at 1.2.0 and nine tags (v1.3.0 …
  // v1.10.1) have been cut with no bump — a publish that dies `EPUBLISHCONFLICT` on all 29 while
  // the gate says shippable. There is no anchor to the version being released unless one is given.
  const version = release ?? internal?.version;
  if (version === undefined) return [];
  const findings: Finding[] = [];
  for (const manifest of published) {
    if (manifest.version !== version) {
      findings.push(versionSkewFinding(manifest.dir, manifest.version, version));
    }
    for (const [dep, range] of manifest.frameworkDeps) {
      if (range !== version) {
        findings.push(pinSkewFinding(manifest.dir, dep, range, version));
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
  docs: ERROR_DOCS_URL,
  at: `packages/${dir}/package.json`,
});

export const publishesTestsFinding = (dir: string): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/package.json does not exclude ${TEST_EXCLUSION} from "files"`,
  fix: `add "${TEST_EXCLUSION}" to "files" in packages/${dir}/package.json, after "src"`,
  docs: ERROR_DOCS_URL,
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
  docs: ERROR_DOCS_URL,
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
  docs: ERROR_DOCS_URL,
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

export interface PackageShapeOptions {
  /**
   * The version being released. Anchors the lockstep rule to it instead of to whatever the
   * packages happen to agree on, which is what lets `scripts/release.ts --check <version>` and the
   * release workflow ask "is this repo actually at the version this tag claims?" before publishing.
   */
  readonly release?: string;
}

/** Every package ships the same contract files; a missing one is a build error, not a chore. */
export async function checkPackageShape(
  root: string,
  options: PackageShapeOptions = {},
): Promise<readonly Finding[]> {
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
  return [
    ...findings,
    ...checkLockstep(facts, options.release),
    ...checkPublishShape(root, facts),
    // Nothing enforced that a workspace joins the root build graph, and `scripts/new-package.ts`
    // never added one — so a package could ship, be imported, and be typechecked by nothing. It
    // rides on this step because it is this step's own question: what does a workspace owe the
    // repo it lives in?
    ...(await checkRootReferences(
      root,
      facts.filter((fact) => !fact.private).map((fact) => fact.dir),
    )),
  ];
}
