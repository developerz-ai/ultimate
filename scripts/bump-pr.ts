#!/usr/bin/env bun
// Answer whether the release bump PR for one version is already open: one `gh pr list` lookup,
// judged by the same `prTwin` matcher `release-due.ts` reads. The PR-side half of
// `.dz/briefs/release-due.md`'s dedupe as a callable surface, so a box never re-types the
// query-and-match pattern — and here the lookup IS the answer, so an unanswerable one refuses.
//
//   bun run scripts/bump-pr.ts --version <X.Y.Z> [--json]

import { renderThrowable } from '@ultimat3/core';
import { flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { GH_TIMEOUT_MS, gh } from './lib/release-due-gh';
import type { AskPr } from './lib/release-due-rule';
import { askPrArgs, parsePrIssues, prTwin } from './lib/release-due-rule';
import type { RunResult } from './lib/run';
import { repoRoot } from './lib/run';

const SCRIPT = 'bump-pr';

/** The version `--version` takes: exactly the next release, as `release-due` prints it. */
const VERSION = /^\d+\.\d+\.\d+$/;

/** The envelope's `data`: the version asked about, and the twin PR whole when one is open. */
export type BumpAnswer =
  | { readonly version: string; readonly open: true; readonly twin: AskPr }
  | { readonly version: string; readonly open: false };

/** `--version`, refused unless the next release exactly as X.Y.Z — the `settleHoursOf` pattern. */
export const versionOf = (raw: string | undefined): string | Finding => {
  if (raw !== undefined && VERSION.test(raw)) return raw;
  return {
    code: 'X_CLI_BAD_FLAG',
    cause: '--version must be the next release as X.Y.Z, as release-due prints in data.next',
    fix: 'bun run scripts/bump-pr.ts --version <X.Y.Z> --json',
    at: 'scripts/bump-pr.ts',
  };
};

/** The lookup pasteable as written: the one argument holding spaces gets the shell's quotes. */
const invocation = (args: readonly string[]): string =>
  ['gh', ...args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ');

/**
 * The answer for `version` at `root`, the `gh` runner injected so a test can answer for it. A
 * failed run, a run killed at its deadline, a `gh` that cannot start at all, or an ok run whose
 * body is not the rows the query promised is a Finding, and deliberately never `{ open: false }`:
 * unlike `release-due.ts`'s best-effort twin note, this script's only product is the lookup, so an
 * unanswerable lookup has no answer to give.
 */
export async function bumpPrAt(
  root: string,
  version: string,
  runGh: typeof gh = gh,
): Promise<BumpAnswer | Finding> {
  const args = askPrArgs(version);
  let listed: RunResult;
  try {
    listed = await runGh(args, root);
  } catch (cause) {
    // Through core's renderer, never `instanceof ? .message : String()`: a Proxy in the caught
    // position makes both halves throw from the one block with nothing left to answer with.
    const detail = renderThrowable(cause);
    return {
      code: 'X_GH_COMMAND_FAILED',
      cause: `${invocation(args)} never answered: ${detail.slice(0, 300)}`,
      fix: invocation(args),
      at: 'scripts/bump-pr.ts',
    };
  }
  if (listed.timedOut) {
    return {
      code: 'X_SPAWN_TIMED_OUT',
      cause: `${invocation(args)} did not finish within ${GH_TIMEOUT_MS} ms and was killed: ${listed.output.slice(0, 300)}`,
      fix: invocation(args),
      at: 'scripts/bump-pr.ts',
    };
  }
  if (!listed.ok) {
    return {
      code: 'X_GH_COMMAND_FAILED',
      cause: `${invocation(args)} exited ${listed.code}: ${listed.output.slice(0, 300)}`,
      fix: invocation(args),
      at: 'scripts/bump-pr.ts',
    };
  }
  // `parsePrIssues` is tolerant by contract — a body that is not rows at all reads as `[]`, and
  // `[]` reads as "none open". Here the lookup IS the answer, so probe the shape first: a body
  // `gh` never wrote (a warning folded into `output` by run(), a truncated answer) must refuse.
  // The read below still goes through parsePrIssues: row-level tolerance stays defined once.
  let rows: unknown;
  try {
    rows = JSON.parse(listed.output);
  } catch {
    rows = undefined;
  }
  if (!Array.isArray(rows)) {
    return {
      code: 'X_GH_COMMAND_FAILED',
      cause: `${invocation(args)} exited 0 but its body is not the promised number,title rows: ${listed.output.slice(0, 300)}`,
      fix: invocation(args),
      at: 'scripts/bump-pr.ts',
    };
  }
  const twin = prTwin(parsePrIssues(listed.output), version);
  return twin === undefined ? { version, open: false } : { version, open: true, twin };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const version = versionOf(flagString(args, 'version'));
  if (typeof version !== 'string') {
    report({ ok: false, script: SCRIPT, summary: 'refused', findings: [version] }, args.json);
  }
  const answer = await bumpPrAt(repoRoot(), version);
  if ('code' in answer) {
    report({ ok: false, script: SCRIPT, summary: 'cannot tell', findings: [answer] }, args.json);
  }
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: answer.open
        ? `a bump PR already open: #${answer.twin.number} ${answer.twin.title}`
        : `no open bump PR for ${version}`,
      lines: answer.open ? [`  twin      #${answer.twin.number} ${answer.twin.title}`] : [],
      data: answer,
    },
    args.json,
  );
}
