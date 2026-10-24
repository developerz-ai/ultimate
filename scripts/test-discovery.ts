#!/usr/bin/env bun
// Refuse a test file the gate's discovery cannot yield, or one filed outside the one convention —
// `TEST_GLOB '**/*.test.{ts,tsx}'`, `packages/cli/src/test-select.ts` — each refused shape with its
// own ground: a basename holding `.spec.` or `_spec.`, or ending `.test.js` or `.test.jsx`, is
// invisible to that glob, so no gate step runs it; a `__tests__/` path IS yielded by it and run by
// the gate, so it is refused for the convention it breaks — a test file lives beside its source,
// never in a `__tests__/` directory; and a colliding basename names no test file at all.
//
// `bun test` at the root is WIDER than the gate's discovery — it reads `*.test.*`, `*_test.*`,
// `*.spec.*` and `*_spec.*`, each with a js/jsx/ts/tsx extension — and it is the run a developer
// reaches for first: a test filed under another convention reads green while the gate never
// executed the file. The rename into the one convention (`<stem>.test.ts` beside the source) puts
// the file back under every gate step at once, so that rename is the fix each finding carries,
// spelt through `renderFixShellArg`: a path is a value a shell reads, and a `fix:` is a command
// meant to be pasted.
//
// The evidence behind two of those grounds: a `__tests__/` path is yielded by the gate's
// `discoverTests()` — TEST_GLOB matches `__tests__/*.test.ts` at any depth, and
// `packages/cli/src/test-ignores.ts` ignores no `__tests__` — so the gate RUNS that file, and it
// is refused for the convention it breaks; and a basename that merely collides is named by a rule
// about test files, because the shape check reads the basename, never the extension, so
// `api.spec.json` names no test at all.
//
// Pinned at ZERO, enforcing outright — the tracked tree holds none today.
//
//   bun run scripts/test-discovery.ts [--json]

import { renderFixShellArg } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'test-discovery';

/** The whole tree, one walk: the refused shape can sit anywhere the gate's ignores do not. */
const ALL_FILES = '**/*';

// Precedent `scripts/lib/side-effects-scan.ts`: installed packages, build output, the checkout's
// own metadata and the manifest cache — a shape seeded under one of these is not a test anyone
// wrote, and walking it would only price the rule by `node_modules`' size.
const SKIP = /(?:^|\/)(?:node_modules|dist|\.git|\.x|\.turbo)\//;

/**
 * The pure half of the rule, one path at a time, asked of the POSIX-normalised repo-relative path
 * the walk produced. It knows nothing of the SKIP list — that a `.spec.` file hidden under
 * `node_modules/` stays unseen is the scan's business, never the shape's. It reads the BASENAME,
 * never the extension, so a name that merely collides (`api.spec.json`) is refused too; the cause
 * says which ground applies, so a finding never reads as "a test the gate missed" about a file
 * that is not one.
 */
export function unseenByDiscovery(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return (
    base.includes('.spec.') ||
    base.includes('_spec.') ||
    base.endsWith('.test.js') ||
    base.endsWith('.test.jsx') ||
    path.split('/').includes('__tests__')
  );
}

/**
 * The same file under the one convention the gate yields: `.spec.`/`_spec.` become `.test.`, a JS
 * extension becomes its TS spelling, and the `__tests__/` segment is dropped so the file sits
 * beside its source. A suggestion, never a performed move — hence the `mv` verb in the fix.
 */
function discoveredName(path: string): string {
  const cut = path.lastIndexOf('/');
  const base = cut === -1 ? path : path.slice(cut + 1);
  const dir = cut === -1 ? [] : path.slice(0, cut).split('/');
  const kept = dir.filter((one) => one !== '__tests__');
  let name = base.replace('.spec.', '.test.').replace('_spec.', '.test.');
  if (name.endsWith('.test.js')) {
    name = `${name.slice(0, -'.js'.length)}.ts`;
  } else if (name.endsWith('.test.jsx')) {
    name = `${name.slice(0, -'.jsx'.length)}.tsx`;
  }
  return [...kept, name].join('/');
}

export interface DiscoveryScan {
  /** Files the walk read past the SKIP list — zero is a blind walk, never a clean tree. */
  readonly files: number;
  /** The refused paths, sorted, repo-relative and POSIX. */
  readonly hits: readonly string[];
}

/** One walk of the whole tree — every refused shape, wherever the gate's discovery is blind. */
export function scanTree(root: string): DiscoveryScan {
  const hits: string[] = [];
  let files = 0;
  for (const found of new Bun.Glob(ALL_FILES).scanSync({ cwd: root, onlyFiles: true })) {
    // scanSync yields host-separator paths on Windows; every other script answers POSIX.
    const path = found.split('\\').join('/');
    if (SKIP.test(path)) continue;
    files += 1;
    if (unseenByDiscovery(path)) hits.push(path);
  }
  return { files, hits: hits.sort() };
}

/**
 * Bun's own root `bun test` discovery — the wider set this rule exists against: `*.test.*`,
 * `*_test.*`, `*.spec.*` and `*_spec.*`, each with a js/jsx/ts/tsx extension. A basename this
 * matches is a test file bun's root run reads; one it does not match is a name that merely
 * COLLIDES with the refused convention, and no run reads it.
 */
const BUN_TEST_FILE = /(?:[._](?:test|spec))\.(?:jsx?|tsx?)$/;

/**
 * The cause for one refused path: the ground that ACTUALLY applies to ITS shape. The shape is not
 * the file's status — a basename the gate's glob cannot match is invisible to every gate step, a
 * `__tests__/` path is yielded and run by the gate and is refused for the convention it breaks,
 * and a basename that merely collides names no test file at all.
 */
const causeOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (path.split('/').includes('__tests__'))
    return `${path} is a test file the gate's discovery DOES yield — TEST_GLOB '**/*.test.{ts,tsx}' matches '__tests__/*.test.ts' at any depth, and packages/cli/src/test-ignores.ts ignores no '__tests__' — so it is refused for the convention it breaks: a test file lives beside its source, never in a '__tests__/' directory`;
  if (!BUN_TEST_FILE.test(base))
    return `${path} is not a test file at all: the shape check reads the basename, never the extension, so a name that merely collides with the refused convention is named by a rule about test files — neither the gate's discovery nor bun's own root bun test reads it`;
  return `${path} is a test file the gate's discovery cannot yield: the gate's unit, contract and job steps select suites through discoverTests() — TEST_GLOB '**/*.test.{ts,tsx}' beside the source (packages/cli/src/test-select.ts) — and that glob matches no basename holding '.spec.' or '_spec.', or ending '.test.js' or '.test.jsx', so no gate step runs it while bun's own root bun test does`;
};

const unseenFinding = (path: string): Finding => {
  const target = renderFixShellArg(discoveredName(path), '<path>');
  return {
    code: 'X_TEST_DISCOVERY_UNSEEN',
    cause: causeOf(path),
    fix: `git mv ${renderFixShellArg(path, '<path>')} ${target}`,
    at: path,
  };
};

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_DISCOVERY_UNSCANNED',
  cause:
    'the walk read zero files, so no test-shaped path was checked — a blind walk answers exactly what a clean tree answers',
  fix: 'bun run scripts/test-discovery.ts --json   # from the repository root; a walk pointed anywhere else, or a SKIP that filters everything, reads zero files',
  at: 'scripts/test-discovery.ts',
});

export function checkDiscovery(scan: DiscoveryScan): readonly Finding[] {
  if (scan.files === 0) return [unscannedFinding()];
  return scan.hits.map(unseenFinding);
}

/** What this rule contributes to `x verify`'s `manifest` step, through `scripts/verify.ts`. */
export const testDiscoveryFindings = async (root: string): Promise<readonly Finding[]> =>
  checkDiscovery(scanTree(root));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const scan = scanTree(repoRoot());
  const findings = checkDiscovery(scan);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `all ${String(scan.files)} file(s) the walk read sit inside the gate's test discovery`
          : findings[0]?.code === 'X_TEST_DISCOVERY_UNSCANNED'
            ? 'this rule read nothing, so no test-shaped path was checked'
            : `${String(findings.length)} file(s) outside the one convention the gate's discovery yields`,
      findings,
      data: { files: scan.files, hits: scan.hits },
    },
    args.json,
  );
}
