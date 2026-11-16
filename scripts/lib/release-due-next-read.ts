// The `next` lane's facts, read from GitHub through `gh`: whether `next` exists and its tip, what
// it changes beside `main`, ci.yml's verdict at that tip and the open proposal PRs. GitHub, not the
// checkout, because CI's clone is shallow and a count of commits over a depth-1 history lies.
// Every lookup that cannot answer says so; none reads as "absent" or "green".

import { loadChangelog } from './changelog-store';
import type { NextBranch, NextCi, NextFacts, NextLaneDecision } from './release-due-next';
import { nextLane } from './release-due-next';
import { askPrArgs, parsePrIssues } from './release-subject';
import type { RunResult } from './run';

/** One `gh` invocation, args only: the caller binds the binary and the cwd. */
export type GhLookup = (args: readonly string[]) => Promise<RunResult | undefined>;

const SHA = /^[0-9a-f]{40}$/;
const NOT_FOUND = /HTTP 404|Branch not found|Not Found/;

/** `gh` arguments, one per question, so a fake can answer each by its first words. */
export const NEXT_BRANCH_ARGS = [
  'api',
  'repos/{owner}/{repo}/branches/next',
  '--jq',
  '.commit.sha',
] as const;
export const NEXT_COMPARE_ARGS = [
  'api',
  'repos/{owner}/{repo}/compare/main...next',
  '--jq',
  '{behind: .behind_by, files: (.files | length)}',
] as const;
export const NEXT_RUNS_ARGS = [
  'run',
  'list',
  '--workflow',
  'ci.yml',
  '--branch',
  'next',
  '--limit',
  '20',
  '--json',
  'headSha,status,conclusion,url',
] as const;

const why = (result: RunResult | undefined): string =>
  result === undefined ? 'gh could not run' : result.output.trim().slice(0, 200) || 'no output';

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function readBranch(result: RunResult | undefined): NextBranch {
  if (result?.ok === true) {
    const sha = result.output.trim();
    return SHA.test(sha) ? { kind: 'present', sha } : { kind: 'unreadable', why: why(result) };
  }
  if (result !== undefined && !result.timedOut && NOT_FOUND.test(result.output)) {
    return { kind: 'absent' };
  }
  return { kind: 'unreadable', why: why(result) };
}

export function readCompare(result: RunResult | undefined): {
  readonly changedFiles?: number;
  readonly behindMain?: number;
} {
  if (result?.ok !== true) return {};
  const row = parse(result.output) as { behind?: unknown; files?: unknown } | undefined;
  const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
  if (row === undefined || !count(row.files) || !count(row.behind)) return {};
  return { changedFiles: row.files, behindMain: row.behind };
}

/** The newest ci.yml run AT `sha` decides; an older tip's green says nothing about this one. */
export function readCi(result: RunResult | undefined, sha: string): NextCi {
  if (result?.ok !== true) return { kind: 'unreadable', why: why(result) };
  const rows = parse(result.output);
  if (!Array.isArray(rows)) return { kind: 'unreadable', why: why(result) };
  const run = rows.find(
    (row: unknown): row is Readonly<Record<string, unknown>> =>
      typeof row === 'object' && row !== null && (row as { headSha?: unknown }).headSha === sha,
  );
  if (run === undefined) return { kind: 'none' };
  const url = typeof run['url'] === 'string' ? run['url'] : '';
  if (run['status'] !== 'completed') return { kind: 'running', url };
  if (run['conclusion'] === 'success') return { kind: 'green', url };
  return { kind: 'red', conclusion: String(run['conclusion'] ?? 'unknown'), url };
}

/** The open-PR titles, or undefined when the lookup could not answer — never "none open". */
export function readPrTitles(result: RunResult | undefined): readonly string[] | undefined {
  if (result?.ok !== true || !Array.isArray(parse(result.output))) return undefined;
  return parsePrIssues(result.output).map((pr) => pr.title);
}

/** Every fact the rule reads, the three after the branch asked together. */
export async function readNextFacts(gh: GhLookup, version: string): Promise<NextFacts> {
  const branch = readBranch(await gh(NEXT_BRANCH_ARGS).catch(() => undefined));
  if (branch.kind !== 'present') return { branch, ci: { kind: 'none' } };
  const [compare, runs, prs] = await Promise.all(
    [NEXT_COMPARE_ARGS, NEXT_RUNS_ARGS, askPrArgs(version)].map((args) =>
      gh(args).catch(() => undefined),
    ),
  );
  const openPrTitles = readPrTitles(prs);
  return {
    branch,
    ...readCompare(compare),
    ci: readCi(runs, branch.sha),
    ...(openPrTitles === undefined ? {} : { openPrTitles }),
  };
}

/** The lane at `root` for a tree stamped `stamped`, today being `nowMs`'s UTC date. */
export async function nextLaneAt(
  root: string,
  stamped: string,
  nowMs: number,
  gh: GhLookup,
): Promise<NextLaneDecision> {
  return nextLane({
    stamped,
    changelog: await loadChangelog(root),
    today: new Date(nowMs).toISOString().slice(0, 10),
    facts: (version) => readNextFacts(gh, version),
  });
}
