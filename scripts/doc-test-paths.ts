#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that a page never hands a reader `bun test <path>`
// without `./`. Bun reads an unanchored argument as a substring FILTER: `bun test packages/core` at
// the root also runs `examples/dummy/packages/core/…` under the wrong config. CLAUDE.md said
// "always `./`" and ~30 pages said otherwise, because nothing checked.
//
//   bun run scripts/doc-test-paths.ts [--json]

import { renderFixShellArg } from '@ultimat3/core';
import { DOC_GLOBS, skipDocPath } from './doc-commands';
import { parseScriptArgs } from './lib/args';
import { bareTestPaths } from './lib/bun-test-paths';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown, scanDocSpans } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/**
 * `doc-commands`' page set, plus the agent briefs under `.claude/`: a slash command is the page an
 * agent copies a test invocation from most often, and doc-commands' `x` rule never needed it.
 */
export const TEST_PATH_GLOBS: readonly string[] = [...DOC_GLOBS, '.claude/**/*.md'];

export interface DocTestPathGap {
  /** `path:line`, or the glob list for the vacuous case. */
  readonly at: string;
  /** The bare argument as written. Empty when no page was read. */
  readonly path: string;
}

/** Pure, so the negative case is a fixture rather than an edit to a page someone else holds. */
export function checkDocTestPaths(files: readonly MarkdownFile[]): readonly DocTestPathGap[] {
  if (files.length === 0) return [{ at: TEST_PATH_GLOBS.join(', '), path: '' }];
  return files.flatMap((file) =>
    scanDocSpans(file).flatMap(({ line, span }) =>
      bareTestPaths(span).map((path) => ({ at: `${file.path}:${line}`, path })),
    ),
  );
}

export const docTestPathFindingFor = (gap: DocTestPathGap): Finding =>
  gap.path === ''
    ? {
        code: 'X_DOC_TEST_PATH_UNSCANNED',
        cause: `no page matched ${gap.at}, so this rule reported green over pages it never read`,
        fix: 'bun run scripts/doc-test-paths.ts --json   # from the repo root; if it still reads nothing, set TEST_PATH_GLOBS in scripts/doc-test-paths.ts to the paths this repo publishes',
        at: gap.at,
      }
    : {
        code: 'X_DOC_TEST_PATH_BARE',
        cause: `${gap.at} hands a reader "bun test ${gap.path}" — without ./ bun reads it as a substring filter, so it also runs every test whose path merely contains it (examples/dummy/${gap.path} included) under the wrong config`,
        fix: `bun test ./${renderFixShellArg(gap.path, '<path>')}   # the spelling to write at ${gap.at}`,
        at: gap.at,
      };

/** Every page once, whatever the glob list; `docs/plans/` and the changelog are records. */
export const readTestPathPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of TEST_PATH_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipDocPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

/** What this repo contributes to `x verify`'s `manifest` step. */
export const docTestPathFindings = async (root: string): Promise<readonly Finding[]> =>
  checkDocTestPaths(await readTestPathPages(root)).map(docTestPathFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await docTestPathFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: 'doc-test-paths',
      summary:
        findings.length === 0
          ? 'every documented bun test path is anchored with ./'
          : `${findings.length} documented bun test path(s) bun reads as a substring filter`,
      findings,
    },
    args.json,
  );
}
