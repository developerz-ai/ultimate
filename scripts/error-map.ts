#!/usr/bin/env bun
// Enforce, as a gate step, that `packages/http/src/error-map.ts`'s status table stays CLOSED. A
// code with no row answers `DEFAULT_STATUS` (500) and `packages/http/src/stages.ts` reports every
// `status >= 500` to the error monitor — so a missing row turns a caller's typo into a 3am page.
// Eleven codes were in that state when this shipped. Runs on `x verify`'s `errors` step, through
// the host-check seam `boundaries` already uses for the tier table.
//
// THE RULE: every declared `X_*` code owned by a tier <= 4 package either has a row, or is pinned
// in `error-map-backlog.ts` — `OFF_SOCKET` (decided, may grow) or `UNDECIDED` (shrink-only). See
// that file for why the classification is recorded rather than derived.
//
//   bun run scripts/error-map.ts [--json]

import { ERROR_STATUS } from '@ultimat3/http';
import {
  backlogCodes,
  backlogGroupOf,
  ERROR_STATUS_BACKLOG,
  OFF_SOCKET,
  UNDECIDED,
} from './error-map-backlog';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { tierOf } from './lib/tiers';
import { collectErrorCodes } from './manifest';
import { statusTableFor } from './new-error-code';

/**
 * Tier 5 is `ui`, `admin`, `testing`, `cli` — three of which never answer a request at all. The
 * fourth, `admin`, mounts `/_x` and DOES throw `X_ADMIN_DENIED` at a browser; it is out of scope
 * here because the dashboard is dev-only (`X_DEV_DASHBOARD_IN_PROD` refuses it elsewhere), so the
 * 500 it answers pages nobody. Widening this to 5 is a one-character edit plus ~80 pins.
 */
export const HTTP_STATUS_MAX_TIER = 4;

export const ERROR_MAP_FILE = 'packages/http/src/error-map.ts';
export const BACKLOG_FILE = 'scripts/error-map-backlog.ts';

/** One declared code, as `scripts/manifest.ts` reports it. */
export interface DeclaredCode {
  readonly code: string;
  readonly owner: string;
  readonly at: string;
}

/**
 * The three ways one table can be wrong. `missing` is the hazard the step exists for; `pinned` is
 * the ratchet's own hygiene (a pin that has been resolved, or that names a code nobody declares any
 * more); `orphan` is a row for a code no package declares — a typo'd row, which reads as enforced
 * and maps nothing.
 */
export type StatusGapKind = 'missing' | 'pinned' | 'orphan';

export interface StatusGap {
  readonly kind: StatusGapKind;
  readonly code: string;
  readonly owner: string;
  readonly at: string;
  /** Only for `pinned`: the status the table now answers, when that is why the pin is stale. */
  readonly status?: number;
}

export interface StatusTableInput {
  readonly declared: readonly DeclaredCode[];
  readonly status: Readonly<Record<string, number>>;
  readonly backlog: Readonly<Record<string, readonly string[]>>;
}

const byCode = (a: StatusGap, b: StatusGap): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/**
 * Pure, so the negative case is a fixture rather than an edit to the real table. Takes the three
 * inputs whole: the declared codes, the framework's status table and the pin list.
 */
export function checkStatusTable(input: StatusTableInput): readonly StatusGap[] {
  const pinned = backlogCodes(input.backlog);
  const required = input.declared.filter((one) => tierOf(one.owner) <= HTTP_STATUS_MAX_TIER);
  const requiredBy = new Map(required.map((one) => [one.code, one]));
  const gaps: StatusGap[] = [];

  for (const one of required) {
    if (Object.hasOwn(input.status, one.code) || pinned.has(one.code)) continue;
    gaps.push({ kind: 'missing', code: one.code, owner: one.owner, at: one.at });
  }

  for (const code of pinned) {
    const declared = requiredBy.get(code);
    const status = input.status[code];
    if (declared !== undefined && status === undefined) continue;
    gaps.push({
      kind: 'pinned',
      code,
      owner: backlogGroupOf(code, input.backlog) ?? '',
      at: BACKLOG_FILE,
      ...(status === undefined ? {} : { status }),
    });
  }

  const declaredCodes = new Set(input.declared.map((one) => one.code));
  for (const code of Object.keys(input.status)) {
    if (declaredCodes.has(code)) continue;
    gaps.push({ kind: 'orphan', code, owner: '', at: ERROR_MAP_FILE });
  }

  return gaps.sort(byCode);
}

/**
 * Which of the two pin lists holds a code, spelled for a `fix:` — "the ai group of UNDECIDED". A
 * fixture's pin is in neither real list and keeps the plain "the ai group".
 */
const groupOf = (code: string, owner: string): string => {
  const list = OFF_SOCKET[owner]?.includes(code)
    ? 'OFF_SOCKET'
    : UNDECIDED[owner]?.includes(code)
      ? 'UNDECIDED'
      : undefined;
  return list === undefined ? `the ${owner} group` : `the ${owner} group of ${list}`;
};

const missingFinding = (gap: StatusGap): Finding => ({
  code: 'X_ERROR_STATUS_MISSING',
  cause: `${gap.code} is owned by @ultimat3/${gap.owner} (tier ${tierOf(gap.owner)}) and has no row in ${ERROR_MAP_FILE}, so a request carrying it answers 500 and pages the on-call`,
  // The SLICE, never the composed table: `error-map.ts` holds no rows of its own.
  fix: `add \`${gap.code}: <status>,\` to ${statusTableFor(gap.owner)} (a slice of ERROR_STATUS in ${ERROR_MAP_FILE}), or, if it can never reach a request, add '${gap.code}' to the ${gap.owner} group of OFF_SOCKET in ${BACKLOG_FILE} with the reason above it — never UNDECIDED, which only shrinks`,
  at: gap.at,
});

const pinnedFinding = (gap: StatusGap): Finding => ({
  code: 'X_ERROR_STATUS_BACKLOG_STALE',
  cause:
    gap.status === undefined
      ? `${gap.code} is pinned in ${BACKLOG_FILE} but no tier <= ${HTTP_STATUS_MAX_TIER} package declares it any more`
      : `${gap.code} is pinned in ${BACKLOG_FILE} and ${ERROR_MAP_FILE} now maps it to ${gap.status} — a pin nobody removes is a pin nobody reads`,
  fix: `delete '${gap.code}' from ${groupOf(gap.code, gap.owner)} in ${BACKLOG_FILE}`,
  at: gap.at,
});

const orphanFinding = (gap: StatusGap): Finding => ({
  code: 'X_ERROR_STATUS_UNKNOWN_CODE',
  cause: `${ERROR_MAP_FILE} maps ${gap.code}, which no package declares — a mistyped row maps nothing and the real code still answers 500`,
  fix: `delete the \`${gap.code}\` row from ERROR_STATUS in ${ERROR_MAP_FILE}, or register ${gap.code} in its owning package's errors.ts`,
  at: gap.at,
});

const FINDINGS: Readonly<Record<StatusGapKind, (gap: StatusGap) => Finding>> = {
  missing: missingFinding,
  pinned: pinnedFinding,
  orphan: orphanFinding,
};

export const statusGapFindingFor = (gap: StatusGap): Finding => FINDINGS[gap.kind](gap);

/** What this repo contributes to `x verify`'s `errors` step. */
export const errorStatusCompleteness = async (root: string): Promise<readonly Finding[]> =>
  checkStatusTable({
    declared: await collectErrorCodes(root),
    status: ERROR_STATUS,
    backlog: ERROR_STATUS_BACKLOG,
  }).map(statusGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const declared = await collectErrorCodes(repoRoot());
  const gaps = checkStatusTable({
    declared,
    status: ERROR_STATUS,
    backlog: ERROR_STATUS_BACKLOG,
  });
  const scope = declared.filter((one) => tierOf(one.owner) <= HTTP_STATUS_MAX_TIER).length;
  report(
    {
      ok: gaps.length === 0,
      script: 'error-map',
      summary:
        gaps.length === 0
          ? `${scope} codes in scope, ${Object.keys(ERROR_STATUS).length} rows, ${backlogCodes().size} pinned — the status table is closed`
          : `${gaps.length} status-table gap(s) across ${scope} codes in scope`,
      findings: gaps.map(statusGapFindingFor),
    },
    args.json,
  );
}
