#!/usr/bin/env bun
// Enforce that a change to a test file never drops a test case its directory's code still has: per
// directory, the `test`/`it` titles present at the base and absent now. A split of mail and render
// suites silently deleted 19 cases and only a review bot noticed. A loss beside a changed or
// deleted source file in the same directory is a warning (tests leave with their code); a loss
// with no source change there is `X_TEST_VANISHED`.
//
//   bun run scripts/vanished-tests.ts [--base <ref>] [--json]

import { renderFixShellArg } from '../packages/core/src/error-render';
import { flagString, parseScriptArgs } from './lib/args';
import { textAt } from './lib/base-ref';
import { changedSince, changedSinceBase } from './lib/changed-files';
import type { Finding } from './lib/log';
import { renderFinding, report } from './lib/log';
import { repoRoot } from './lib/run';
import { testTitles } from './lib/test-titles';

const SCRIPT = 'vanished-tests';
const TEST_FILE = /\.test\.[cm]?tsx?$/;
const SOURCE_FILE = /\.[cm]?tsx?$/;

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '.';

export interface VanishedGap {
  readonly dir: string;
  readonly title: string;
  /** No source file of `dir` changed: nothing explains the loss. */
  readonly blocking: boolean;
}

/** Each title the base held more often than HEAD does, per directory — a multiset difference. */
export function vanishedGaps(
  titles: ReadonlyMap<
    string,
    { readonly base: readonly string[]; readonly head: readonly string[] }
  >,
  sourceTouched: ReadonlySet<string>,
): readonly VanishedGap[] {
  const gaps: VanishedGap[] = [];
  for (const [dir, { base, head }] of [...titles].sort(([a], [b]) => a.localeCompare(b))) {
    const left = new Map<string, number>();
    for (const title of head) left.set(title, (left.get(title) ?? 0) + 1);
    for (const title of base) {
      const held = left.get(title) ?? 0;
      if (held > 0) left.set(title, held - 1);
      else gaps.push({ dir, title, blocking: !sourceTouched.has(dir) });
    }
  }
  return gaps;
}

const findingFor = (gap: VanishedGap): Finding => ({
  code: 'X_TEST_VANISHED',
  cause: gap.blocking
    ? `the test "${gap.title}" is in ${gap.dir} at the base and in no test file there now, while no source file of ${gap.dir} changed — a split or rewrite that dropped a case`
    : `the test "${gap.title}" left ${gap.dir}, beside a change to its source there — confirm it left with the code it tested`,
  fix: `git diff --stat origin/main -- ${renderFixShellArg(gap.dir, '<the directory>')}   # restore the case in a test file of that directory, or delete the code it tested in the same change`,
  at: gap.dir,
});

export interface VanishedResult {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly warnings: readonly Finding[];
  readonly base: string | undefined;
}

/** The diff against `base` (default: the merge base with `origin/main`), read and judged. */
export async function vanishedTests(root: string, base?: string): Promise<VanishedResult> {
  const diff = base === undefined ? await changedSinceBase(root) : await changedSince(root, base);
  if (diff.base === undefined) {
    const missing: Finding = {
      code: 'X_PREFLIGHT_BASE_MISSING',
      cause: 'this checkout has no origin/main, so no test file can be compared with its base',
      fix: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main   # then rerun: bun run scripts/vanished-tests.ts',
    };
    return { ok: false, findings: [missing], warnings: [], base: undefined };
  }
  const titles = new Map<string, { base: string[]; head: string[] }>();
  const sourceTouched = new Set<string>();
  for (const path of diff.changed) {
    if (!TEST_FILE.test(path)) {
      if (SOURCE_FILE.test(path)) sourceTouched.add(dirOf(path));
      continue;
    }
    const entry = titles.get(dirOf(path)) ?? { base: [], head: [] };
    titles.set(dirOf(path), entry);
    entry.base.push(...testTitles((await textAt(root, diff.base, path)) ?? ''));
    const now = Bun.file(`${root}/${path}`);
    if (await now.exists()) entry.head.push(...testTitles(await now.text()));
  }
  const gaps = vanishedGaps(titles, sourceTouched);
  const findings = gaps.filter((gap) => gap.blocking).map(findingFor);
  const warnings = gaps.filter((gap) => !gap.blocking).map(findingFor);
  return { ok: findings.length === 0, findings, warnings, base: diff.base };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const result = await vanishedTests(repoRoot(), flagString(args, 'base'));
  report(
    {
      ok: result.ok,
      script: SCRIPT,
      summary: result.ok
        ? `no test case vanished without its code (${String(result.warnings.length)} warning(s))`
        : `${String(result.findings.length)} test case(s) vanished with no source change beside them`,
      findings: result.findings,
      lines: result.warnings.map((warning) => `warning:\n${renderFinding(warning)}`),
      data: { base: result.base, warnings: result.warnings },
    },
    args.json,
  );
}
