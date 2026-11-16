// The stale-branches row: `dz/*` branches — the maintainer fleet's work branches — left behind once
// their pull request merged or closed, or idle past a week with none. One GraphQL read answers each
// branch's tip date and newest pull request; the row lists the stale ones and names the delete,
// and never deletes: removing a remote branch is an operator's act.

import { renderFixShellArg } from '@ultimat3/core';
import { jsonDocument } from './health-narrow';
import type { RowVerdict, StaleBranch } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';

const PREFIX = 'dz/';
/** A PR-less branch idle this long was abandoned; a fresh one may be work a box is still doing. */
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** The query lives beside this file, so the brief's command stays a line: gh reads `@path`. */
const QUERY_FILE = 'scripts/lib/health-branches.graphql';
const ARGS = ['api', 'graphql', '-F', `query=@${QUERY_FILE}`] as const;

// Exported for the brief's test and the reader's: a re-run is the same query, from the repo root.
export const BRANCHES_COMMAND = `gh ${ARGS.join(' ')}`;

export interface BranchesRead {
  readonly refs: unknown;
}

type Gh = (args: readonly string[], cwd: string) => Promise<RunResult>;

export const branchesReader = async (root: string, ghRunner: Gh): Promise<BranchesRead> => ({
  refs: jsonDocument((await ghRunner(ARGS, root)).output),
});

const rec = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

interface Branch extends StaleBranch {
  readonly idleMs: number;
}

const narrowBranch = (value: unknown, nowMs: number): Branch | undefined => {
  const ref = rec(value);
  const name = ref?.['name'];
  const committedAt = rec(ref?.['target'])?.['committedDate'];
  const prs = rec(ref?.['associatedPullRequests'])?.['nodes'];
  const at = typeof committedAt === 'string' ? Date.parse(committedAt) : Number.NaN;
  if (typeof name !== 'string' || !Number.isFinite(at) || !Array.isArray(prs)) return undefined;
  const pr = rec(prs[0]);
  const number = pr?.['number'];
  const state = pr?.['state'];
  return {
    name: `${PREFIX}${name}`,
    committedAt: String(committedAt),
    pr: typeof number === 'number' && typeof state === 'string' ? { number, state } : undefined,
    idleMs: nowMs - at,
  };
};

const isStale = (branch: Branch): boolean =>
  branch.pr === undefined ? branch.idleMs > IDLE_MS : branch.pr.state !== 'OPEN';

export const judgeBranches = (read: BranchesRead, nowMs: number): RowVerdict | Finding => {
  const base = { row: 'stale-branches' as const };
  const refs = rec(rec(rec(rec(read.refs)?.['data'])?.['repository'])?.['refs']);
  const nodes = refs?.['nodes'];
  const total = refs?.['totalCount'];
  const branches = Array.isArray(nodes) ? nodes.map((one) => narrowBranch(one, nowMs)) : [];
  const parsed = branches.filter((one): one is Branch => one !== undefined);
  if (!Array.isArray(nodes) || typeof total !== 'number' || parsed.length < nodes.length) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the stale-branches row could not be read: ${BRANCHES_COMMAND} — gh printed no readable refs document`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  if (parsed.length < total) {
    const reason = `${parsed.length} of ${total} ${PREFIX}* branches read: the page is truncated — re-run before filing`;
    return { ...base, verdict: 'unverdicted', reason };
  }
  const stale = parsed.filter(isStale).map(({ idleMs: _, ...one }) => one);
  if (stale.length === 0) {
    return { ...base, verdict: 'healthy', reason: `no merged, closed or idle ${PREFIX}* branch` };
  }
  return {
    ...base,
    verdict: 'unhealthy',
    reason: `${stale.length} stale ${PREFIX}* branch(es): merged or closed, or a week idle with no pull request`,
    fix: stale
      .map((one) => `git push origin --delete ${renderFixShellArg(one.name, '<branch>')}`)
      .join(' && '),
    branches: stale,
  };
};
