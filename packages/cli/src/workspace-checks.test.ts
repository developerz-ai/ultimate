import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixProblem } from './error-contract';
import type { ManifestFacts } from './workspace-checks';
import {
  ARTIFACT_ALLOWLIST,
  badVersionFinding,
  buildArtifactsFinding,
  checkFileSizes,
  checkLockstep,
  checkPackageShape,
  checkPublishShape,
  countLines,
  filesOf,
  frameworkDepsOf,
  hasWorkspacePackages,
  LINE_CEILING,
  missingPublishedFileFinding,
  noFilesAllowlistFinding,
  PACKAGE_FILES,
  pinSkewFinding,
  publishesTestsFinding,
  TEST_EXCLUSION,
  workspacePackages,
} from './workspace-checks';

/** A sibling pin the release script bumped everywhere except here — the skew that actually shipped. */
const STALE_PEER = { '@ultimat3/action': '0.0.1' };
const STALE_OPTIONAL = { '@ultimat3/db': '0.0.1' };

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

let dir = '';

/** Terminated by a newline, like every file Biome formats — the case the count has to get right. */
const lines = (count: number): string =>
  `${Array.from({ length: count }, () => 'const x = 1;').join('\n')}\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-workspace-checks-'));
  await Bun.write(join(dir, 'packages/short/src/index.ts'), lines(LINE_CEILING));
  await Bun.write(join(dir, 'packages/short/README.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/CLAUDE.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/tsconfig.json'), '{}\n');
  await Bun.write(join(dir, 'packages/short/LICENSE'), 'MIT\n');
  // `short` is the control: a package that satisfies every rule, so a finding against it is a
  // real one. That includes the publish contract — a manifest with no `files` ships the directory.
  await Bun.write(
    join(dir, 'packages/short/package.json'),
    `{"name":"short","version":"1.2.3","files":["src","${TEST_EXCLUSION}","README.md","LICENSE"]}\n`,
  );
  await Bun.write(join(dir, 'packages/long/src/index.ts'), lines(LINE_CEILING + 1));
  await Bun.write(join(dir, 'packages/long/package.json'), '{"name":"long"}\n');
  await Bun.write(join(dir, 'packages/long/node_modules/dep/src/huge.ts'), lines(2_000));
  await Bun.write(join(dir, 'app/orgs/page.tsx'), lines(LINE_CEILING + 40));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unit · the file-size ceiling', () => {
  test('one line over the ceiling is a finding, exactly at it is not', async () => {
    const findings = await checkFileSizes(dir);
    const paths = findings.map((finding) => finding.at);
    expect(paths).toContain('packages/long/src/index.ts');
    expect(paths).not.toContain('packages/short/src/index.ts');
    expect(findings.every((finding) => finding.code === 'X_FILE_TOO_LONG')).toBe(true);
  });

  // The ceiling is 500, so it has to be 500 — off by one it enforces 499 and every count it
  // reports is a line too high, which sends an author to split a file that already fits.
  test('a terminating newline is not a line of its own', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\n\n')).toBe(2);
    expect(countLines(lines(LINE_CEILING))).toBe(LINE_CEILING);
  });

  test('a file exactly at the ceiling is counted at the ceiling, not over it', async () => {
    const at = join(dir, 'packages/edge/src/index.ts');
    await Bun.write(at, lines(LINE_CEILING));
    await Bun.write(join(dir, 'packages/edge/src/over.ts'), lines(LINE_CEILING + 1));

    const findings = await checkFileSizes(dir);
    const over = findings.find((finding) => finding.at === 'packages/edge/src/over.ts');

    expect(findings.map((finding) => finding.at)).not.toContain('packages/edge/src/index.ts');
    expect(over?.cause).toContain(`${LINE_CEILING + 1} lines`);
  });

  test('app surfaces are scanned too, and dependencies are not', async () => {
    const paths = (await checkFileSizes(dir)).map((finding) => finding.at);
    expect(paths).toContain('app/orgs/page.tsx');
    expect(paths.some((path) => path?.includes('node_modules'))).toBe(false);
  });

  test('every finding names the file it is about in its fix', async () => {
    for (const finding of await checkFileSizes(dir)) {
      expect(finding.fix).toContain(finding.at ?? '');
    }
  });

  // Emitted declarations are not authored source — a stale `.d.ts` over the ceiling is not a
  // reason to split anything, so the rule cannot even reach it. The `.ts` beside it is what keeps
  // that provable: a walk that stopped reporting everything would pass on the `.d.ts` alone.
  test('a generated declaration over the ceiling is not walked at all', async () => {
    const genDir = await mkdtemp(join(tmpdir(), 'ultimate-workspace-checks-gen-'));
    try {
      await Bun.write(join(genDir, 'packages/stale/src/huge.d.ts'), lines(LINE_CEILING + 1));
      await Bun.write(join(genDir, 'packages/stale/src/huge.ts'), lines(LINE_CEILING + 1));

      const findings = await checkFileSizes(genDir);

      expect(findings.map((finding) => finding.at)).toContain('packages/stale/src/huge.ts');
      expect(findings.map((finding) => finding.at)).not.toContain('packages/stale/src/huge.d.ts');
    } finally {
      await rm(genDir, { recursive: true, force: true });
    }
  });
});

describe('unit · the package shape', () => {
  test('a package missing a contract file is reported once per file', async () => {
    const findings = await checkPackageShape(dir);
    expect(findings.map((finding) => finding.at)).toEqual([
      'packages/long/README.md',
      'packages/long/CLAUDE.md',
      'packages/long/tsconfig.json',
      'packages/long/package.json',
    ]);
    expect(findings.every((finding) => finding.code === 'X_PACKAGE_SHAPE')).toBe(true);
  });

  test('a manifest with no semver version is a finding, not a silent 0.0.0', async () => {
    // Every published package reads its own version back at runtime, so this is the difference
    // between a working `x --version` and one that prints `undefined` to whoever installed it.
    expect(badVersionFinding('long', undefined).fix).toContain('packages/long/package.json');
    const bad = await mkdtemp(join(tmpdir(), 'ultimate-version-'));
    for (const file of PACKAGE_FILES) await Bun.write(join(bad, 'packages/p', file), '{}\n');
    await Bun.write(join(bad, 'packages/p/package.json'), '{"name":"p","version":"latest"}\n');
    const findings = await checkPackageShape(bad);
    expect(findings.map((finding) => finding.at)).toEqual(['packages/p/package.json']);
    expect(findings[0]?.cause).toContain('"latest"');
    await rm(bad, { recursive: true, force: true });
  });

  test('build artifacts in src/ are reported as findings', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'ultimate-artifacts-'));
    for (const file of PACKAGE_FILES) await Bun.write(join(bad, 'packages/p', file), '{}\n');
    await Bun.write(join(bad, 'packages/p/package.json'), '{"name":"p","version":"1.0.0"}\n');
    await Bun.write(join(bad, 'packages/p/src/index.ts'), 'export const x = 1;\n');
    await Bun.write(join(bad, 'packages/p/src/index.d.ts'), 'export const x: number;\n');
    await Bun.write(join(bad, 'packages/p/src/index.js'), 'exports.x = 1;\n');
    await Bun.write(join(bad, 'packages/p/src/index.js.map'), '{"version":3}\n');
    const findings = await checkPackageShape(bad);
    const artifactFindings = findings.filter(
      (f) => f.code === 'X_PACKAGE_SHAPE' && f.at === 'packages/p/src/',
    );
    expect(artifactFindings).toHaveLength(1);
    expect(artifactFindings[0]?.cause).toContain('3 build artifacts');
    await rm(bad, { recursive: true, force: true });
  });

  // Axiom 4: the fix is the remediation, not a description of it. This one is the sweep itself, so
  // it has to name the directory it clears, the three suffixes, and every file it must not take.
  test('the artifact fix is the sweep, runnable as written', () => {
    const { fix } = buildArtifactsFinding('p', 3);
    expect(fix.startsWith('find packages/p/src ')).toBe(true);
    expect(fix.endsWith(' -delete')).toBe(true);
    for (const suffix of ['*.d.ts', '*.js', '*.map']) expect(fix).toContain(`-name '${suffix}'`);
    for (const path of ARTIFACT_ALLOWLIST) expect(fix).toContain(`! -path '${path}'`);
    expect(fixProblem(fix)).toBeUndefined();
  });

  // `tsc -b` builds referenced projects only, so a workspace outside the root `references` is one
  // the gate's `typecheck` step never opens. Asserted through `checkPackageShape` and not through
  // the rule alone, because a rule nothing calls is exactly the failure mode being closed.
  test('a published workspace outside the root references is a package-shape finding', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'ultimate-refs-'));
    try {
      for (const file of PACKAGE_FILES) await Bun.write(join(bad, 'packages/p', file), '{}\n');
      const manifest = (extra: string): string =>
        `{"name":"p","version":"1.0.0",${extra}"files":["src","${TEST_EXCLUSION}"]}\n`;
      await Bun.write(join(bad, 'tsconfig.json'), '{"files":[],"references":[]}\n');
      await Bun.write(join(bad, 'packages/p/package.json'), manifest(''));
      const findings = await checkPackageShape(bad);
      expect(findings.map((finding) => finding.code)).toContain('X_PACKAGE_UNREFERENCED');
      // A private package is not a shipped contract, and a generated app's are all private.
      await Bun.write(join(bad, 'packages/p/package.json'), manifest('"private":true,'));
      const exempt = await checkPackageShape(bad);
      expect(exempt.map((finding) => finding.code)).not.toContain('X_PACKAGE_UNREFERENCED');
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  test('scss.d.ts in ui/src is allowlisted and not reported', async () => {
    const good = await mkdtemp(join(tmpdir(), 'ultimate-ui-scss-'));
    for (const file of PACKAGE_FILES) await Bun.write(join(good, 'packages/ui', file), '{}\n');
    await Bun.write(join(good, 'packages/ui/package.json'), '{"name":"ui","version":"1.0.0"}\n');
    await Bun.write(join(good, 'packages/ui/src/index.ts'), 'export const x = 1;\n');
    await Bun.write(join(good, 'packages/ui/src/scss.d.ts'), 'export {};\n');
    const findings = await checkPackageShape(good);
    expect(findings.filter((f) => f.at === 'packages/ui/src/')).toEqual([]);
    await rm(good, { recursive: true, force: true });
  });

  // Emit is not committed, so how much of it is on disk is a fact about this machine: a clean
  // checkout carries none and a checkout somebody has built in carries hundreds. Asserting a count
  // either way would be a test of the working tree — the fixtures above are what prove detection.
  // What is invariant here is the shape: every package carries its contract files, and any artifact
  // finding this tree does produce is one an author can act on.
  test('this repo satisfies the shape it enforces, whatever emit is lying around', async () => {
    const findings = await checkPackageShape(REPO_ROOT);
    for (const finding of findings.filter((f) => f.at?.endsWith('/src/'))) {
      expect(finding.code).toBe('X_PACKAGE_SHAPE');
      expect(fixProblem(finding.fix)).toBeUndefined();
      expect(finding.fix).toContain(finding.at?.replace(/\/$/, '') ?? '');
    }
    const contractFindings = findings.filter((f) => f.cause?.includes('has no'));
    expect(contractFindings).toEqual([]);
    // The ratchet for the rule above: every published package here is in the root build graph.
    expect(findings.filter((f) => f.code === 'X_PACKAGE_UNREFERENCED')).toEqual([]);
    expect(await workspacePackages(REPO_ROOT)).toContain('cli');
    expect(PACKAGE_FILES).toHaveLength(4);
  });

  test('the step is skipped where there are no workspace packages', async () => {
    expect(await hasWorkspacePackages(dir)).toBe(true);
    expect(await hasWorkspacePackages(join(dir, 'app'))).toBe(false);
  });
});

const pkg = (over: Partial<ManifestFacts> & { dir: string }): ManifestFacts => ({
  name: `@ultimat3/${over.dir}`,
  version: '1.0.0',
  private: false,
  frameworkDeps: [],
  files: ['src', TEST_EXCLUSION, 'README.md', 'LICENSE'],
  ...over,
});

describe('checkLockstep', () => {
  test('every published package at one version, pins included, is clean', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '1.0.0']] }),
      ]),
    ).toEqual([]);
  });

  test('a package left behind at the old version is a finding', () => {
    const findings = checkLockstep([pkg({ dir: 'core' }), pkg({ dir: 'ui', version: '0.0.1' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_RELEASE_VERSION_SKEW');
    expect(findings[0]?.cause).toBe('packages/ui is at 0.0.1, not the lockstep version 1.0.0');
    expect(findings[0]?.fix).toBe('bun run scripts/release.ts --version 1.0.0');
  });

  // The release this check exists for: every own version moved to 1.0.0 and every sibling pin
  // stayed at 0.0.1, so @ultimat3/jobs@1.0.0 published naming a @ultimat3/core@0.0.1 that is not
  // on the registry. Nothing in the repo failed; every install of the release did.
  test('a stale sibling pin is a finding even when both versions are right', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '0.0.1']] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toBe(
      'packages/jobs pins @ultimat3/core at 0.0.1, not the lockstep version 1.0.0',
    );
  });

  test('core is the anchor, so one stray package does not indict every other', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'http' }),
      pkg({ dir: 'ui', version: '9.9.9' }),
    ]);
    expect(findings.map((finding) => finding.at)).toEqual(['packages/ui/package.json']);
  });

  // A generated app has `packages/*` too: private, on their own version line, depending on the
  // framework by caret range. Reporting those would fail `x verify` on unmodified scaffold output.
  test('private packages are exempt on both counts', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({
          dir: 'db',
          private: true,
          version: '0.0.1',
          frameworkDeps: [['@ultimat3/entity', '^1.0.0']],
        }),
      ]),
    ).toEqual([]);
  });

  test('no published package at all is a no-op, not a crash', () => {
    expect(checkLockstep([pkg({ dir: 'db', private: true })])).toEqual([]);
    expect(checkLockstep([])).toEqual([]);
  });

  // Without an external anchor the rule compares packages only to EACH OTHER, so a repo where all
  // 29 sit at 1.2.0 is green even though the tag being published says v1.10.1 — and `npm publish`
  // then dies `EPUBLISHCONFLICT` on all 29. The gate was green while the tag lied.
  test('a release version anchors the check outside the repo', () => {
    const manifests = [
      pkg({ dir: 'core' }),
      pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '1.0.0']] }),
    ];
    expect(checkLockstep(manifests)).toEqual([]);
    const findings = checkLockstep(manifests, '1.10.1');
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_RELEASE_VERSION_SKEW',
      'X_RELEASE_VERSION_SKEW',
      'X_RELEASE_VERSION_SKEW',
    ]);
    expect(findings[0]?.cause).toContain('not the lockstep version 1.10.1');
    // The version being released is the anchor whether or not any package already carries it.
    expect(checkLockstep(manifests, '1.0.0')).toEqual([]);
  });
});

describe('frameworkDepsOf', () => {
  test('reads @ultimat3 dependencies and ignores everything else', () => {
    expect(
      frameworkDepsOf({
        dependencies: { '@ultimat3/core': '1.0.0', 'solid-js': '^2.0.0' },
        devDependencies: { '@ultimat3/testing': '1.0.0' },
      }),
    ).toEqual([['@ultimat3/core', '1.0.0']]);
  });

  test('peer and optional pins are published too, so they count', () => {
    expect(
      frameworkDepsOf({
        dependencies: { '@ultimat3/core': '1.0.0' },
        peerDependencies: { '@ultimat3/http': '1.0.0' },
        optionalDependencies: { '@ultimat3/schema': '1.0.0' },
      }),
    ).toEqual([
      ['@ultimat3/core', '1.0.0'],
      ['@ultimat3/http', '1.0.0'],
      ['@ultimat3/schema', '1.0.0'],
    ]);
  });

  test('devDependencies stay excluded — npm never installs them for a consumer', () => {
    expect(frameworkDepsOf({ devDependencies: { '@ultimat3/testing': '0.0.1' } })).toEqual([]);
  });

  test('a manifest with no dependencies block reads as none', () => {
    expect(frameworkDepsOf({})).toEqual([]);
    expect(frameworkDepsOf(null)).toEqual([]);
  });
});

describe('a stale pin in any published field is skew', () => {
  test('a peer pin left behind is reported', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({ dir: 'render', frameworkDeps: frameworkDepsOf({ peerDependencies: STALE_PEER }) }),
      ]),
    ).toEqual([pinSkewFinding('render', '@ultimat3/action', '0.0.1', '1.0.0')]);
  });

  test('an optional pin left behind is reported', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({
          dir: 'ai',
          frameworkDeps: frameworkDepsOf({ optionalDependencies: STALE_OPTIONAL }),
        }),
      ]),
    ).toEqual([pinSkewFinding('ai', '@ultimat3/db', '0.0.1', '1.0.0')]);
  });
});

describe('checkPublishShape', () => {
  // The 1.0.0 defect, as a test: all 28 manifests declared "license": "MIT", named LICENSE in
  // `files`, and shipped the text in none of them. npm drops a `files` entry with no file behind
  // it without a word, so every check upstream of the registry stayed green.
  test('a published package promising a file it does not have is a finding', () => {
    const files = ['src', TEST_EXCLUSION, 'README.md', 'LICENSE', 'CHANGELOG.md'];
    expect(checkPublishShape(dir, [pkg({ dir: 'short', files })])).toEqual([
      missingPublishedFileFinding('short', 'CHANGELOG.md'),
    ]);
  });

  test('a package carrying everything it promises is clean', () => {
    expect(checkPublishShape(dir, [pkg({ dir: 'short' })])).toEqual([]);
  });

  // Told to add an entry to a "files" that is not there, an author edits a key that does not
  // exist — so the two conditions report separately and each `fix:` stays runnable.
  test('a published package with no files allowlist is its own finding', () => {
    expect(checkPublishShape(dir, [pkg({ dir: 'short', files: [] })])).toEqual([
      noFilesAllowlistFinding('short'),
    ]);
  });

  // `src` sweeps in every `*.test.ts` beside it: 393 files across the framework, over half of
  // @ultimat3/cli's tarball, all of it run against a preloaded clock a consumer does not have.
  test('a published package that does not exclude its tests is a finding', () => {
    expect(checkPublishShape(dir, [pkg({ dir: 'short', files: ['src'] })])).toEqual([
      publishesTestsFinding('short'),
    ]);
  });

  test('a negation and a glob are never existence-checked — only a literal promises a file', () => {
    const files = ['src', TEST_EXCLUSION, '!nothing-here', 'src/**/*.json'];
    expect(checkPublishShape(dir, [pkg({ dir: 'short', files })])).toEqual([]);
  });

  // A generated app's packages/* are private, carry no `files` and never reach a registry — the
  // rule has to skip them or `x new` scaffolds an app whose very first gate run is red.
  test('a private package is exempt from both halves', () => {
    expect(checkPublishShape(dir, [pkg({ dir: 'short', private: true, files: [] })])).toEqual([]);
  });

  test('filesOf reads the array, and a manifest without one as none', () => {
    expect(filesOf({ files: ['src', 'LICENSE'] })).toEqual(['src', 'LICENSE']);
    expect(filesOf({ files: ['src', 7] })).toEqual(['src']);
    expect(filesOf({})).toEqual([]);
    expect(filesOf(null)).toEqual([]);
  });
});

// Over the real repo, not a fixture: this is the assertion that would have stopped the 1.0.0
// tarballs from reaching npm without the grant they claim, and it stays true for every release
// after — a publish cannot be undone.
describe('integration · every published package ships what it promises', () => {
  test('no framework package promises a file it does not carry, or publishes its tests', async () => {
    const findings = await checkPackageShape(REPO_ROOT);
    // Emit under `src/` is its own rule and its own fix, and whether any is on disk is a fact about
    // this machine — reading it here would make the publish contract answer a question it is not
    // asking.
    const publishFindings = findings.filter(
      (finding) => finding.code === 'X_PACKAGE_SHAPE' && !finding.at?.endsWith('/src/'),
    );
    expect(publishFindings).toEqual([]);
  });
});
