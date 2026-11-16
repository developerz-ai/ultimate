#!/usr/bin/env bun
// Enforce, as a gate step, that no test replaces a node builtin with `mock.module`. Bun's module
// mock is PROCESS-global and outlives the file that installed it: under the `flaky` job (every
// changed test in one process) and `--randomize`, a mocked `node:fs` or `node:child_process` is
// what the NEXT file reads. Every spelling counts — `node:fs`, `fs`, `fs/promises` — checked
// against `node:module`'s `builtinModules`. The alternative is a seam: inject the dependency, or
// `spyOn` the function the code under test is handed, which `mock.restore()` undoes per test.
//
//   bun run scripts/test-mock-builtin.ts [--json]
//   bun run scripts/test-mock-builtin.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

// why: the authoritative list of node's builtin module names; Bun has no equivalent.
import { builtinModules } from 'node:module';
import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { insideString, sourceStrings } from './lib/source-strings';
import { MOCK_BUILTIN_PINS, PINS_FILE } from './lib/test-mock-builtin-pins';
import { readTestSources } from './test-fix-citations';

const SCRIPT = 'test-mock-builtin';
const EXPLAIN = 'bun run scripts/test-mock-builtin.ts --explain --json lists every one';

/** `mock.module(` and its first argument, when that is a literal: the module it replaces. */
const MOCK = /(?<![\w$])mock\.module\s*\(\s*(['"`])([^'"`]+)\1/g;
/** A test file, the only place `mock` is in scope. */
const TEST_FILE = /\.test\.tsx?$/;
const BUILTINS = new Set(builtinModules);

/** `node:fs/promises`, `fs`, `fs/promises`: a builtin by any of its names. */
export const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || BUILTINS.has(specifier);

export interface MockBuiltinSite {
  readonly path: string;
  readonly line: number;
  /** The module as the test named it. */
  readonly module: string;
}

export function scanMockBuiltins(path: string, source: string): readonly MockBuiltinSite[] {
  if (!TEST_FILE.test(path) || !source.includes('mock.module')) return [];
  // Comments are prose; a rule's own test spells the bad shape as a STRING: neither is a mock.
  const code = stripComments(source);
  const literals = sourceStrings(source);
  const out: MockBuiltinSite[] = [];
  for (const match of code.matchAll(MOCK)) {
    const at = match.index ?? 0;
    if (insideString(literals, at)) continue;
    const module = source.slice(at, at + match[0].length).match(/(['"`])([^'"`]+)\1/)?.[2] ?? '';
    if (!isBuiltin(module)) continue;
    out.push({ path, line: source.slice(0, at).split('\n').length, module });
  }
  return out;
}

export type MockBuiltinGap = RatchetGap<MockBuiltinSite>;

export interface MockBuiltinInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}

export const checkMockBuiltins = (input: MockBuiltinInput): readonly MockBuiltinGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanMockBuiltins(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: MockBuiltinSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} ${site.module}`;

const overFinding = (gap: MockBuiltinGap): Finding => ({
  code: 'X_TEST_MOCK_BUILTIN',
  cause: `${gap.pkg} has ${String(gap.found)} test(s) replacing a node builtin with mock.module and is pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — Bun's module mock is process-global and outlives the file, so under the flaky job and --randomize the next file in the process reads the fake`,
  fix: `spyOn(fsLike, 'readFile').mockResolvedValue(text)   # at ${siteTarget(gap, at)}: inject the dependency (pass the fs/spawn the code under test calls) and spy on the function it receives — mock.restore() undoes a spy per test; never mock.module a builtin`,
  at: leadSite(gap)?.path ?? PINS_FILE,
});

const staleFinding = (gap: MockBuiltinGap): Finding => ({
  code: 'X_TEST_MOCK_BUILTIN_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} builtin module mock(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/test-mock-builtin.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_MOCK_BUILTIN_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "bun run scripts/test-mock-builtin.ts --explain --json   # reads nothing: TEST_GLOBS in scripts/test-fix-citations.ts must match this repo's test layout",
  at: 'scripts/test-mock-builtin.ts',
});

export const mockBuiltinFindingFor = (gap: MockBuiltinGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const treeSites = async (root: string): Promise<readonly MockBuiltinSite[]> =>
  (await readTestSources(root)).flatMap((file) => scanMockBuiltins(file.path, file.text));

const PROBE: SiteProbe<MockBuiltinSite> = { rescan: scanMockBuiltins, line: (site) => site.line };

export const mockBuiltinGaps = async (root: string): Promise<readonly MockBuiltinGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), MOCK_BUILTIN_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const mockBuiltinFindings = async (root: string): Promise<readonly Finding[]> =>
  (await mockBuiltinGaps(root)).map(mockBuiltinFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: MOCK_BUILTIN_PINS,
    sites: treeSites,
    findingFor: mockBuiltinFindingFor,
    probe: PROBE,
    clean: 'no test replaces a node builtin with mock.module',
  });
}
