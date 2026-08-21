#!/usr/bin/env bun
// Enforce, as a gate rule, that `wiki/Error-Codes.md`'s "never ships to an app" parenthesis is
// complete in both directions: every code it names has a table row, and every code `scripts/`
// declares is named in it.
//
// The gap this closes: nothing read that parenthesis. `checkErrorCodeDocs` is satisfied by ANY
// `X_FOO` in a backtick anywhere on the page — `documentedCodes` is one regex over the whole file —
// so being named INSIDE the parenthesis counts as being documented, and `X_LOCKFILE_STALE`,
// `X_RELEASE_VERSION_UNSTATED` and eighteen others have no row at all. From the other side,
// `checkErrorCodeRegistry` exempts gate codes by SCANNING `scripts/` (`hostOwnedCodes` in
// scripts/verify.ts), never by reading the list — so the list is a hand-copy of a derived set with
// no check on it, which is the same shape `gate-steps.ts` and `release-facts.ts` exist for. Four
// `X_REGISTRY_*` codes are missing from it today, and the sentence around it says every code above
// `## Reserved codes` resolves through `x errors explain` except the ones it names.
//
//   bun run scripts/gate-codes.ts [--json]

import { collectDeclaredCodes } from '@ultimat3/cli';
import { GATE_CODE_NO_ROW, GATE_CODE_UNLISTED } from './gate-codes-backlog';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'gate-codes';
export const ERROR_REFERENCE = 'wiki/Error-Codes.md';
export const BACKLOG_FILE = 'scripts/gate-codes-backlog.ts';

/**
 * Where the parenthesis starts. Matched on the prose that introduces it rather than on a line
 * number, because the page is edited far more often than this rule is.
 */
export const NEVER_SHIPS_LEAD = "this repository's own gate scripts (";

/**
 * The codes the parenthesis names, `X_ROADMAP_*`-style wildcards included. Read from the lead to
 * the first `)` after it: the sentence continues past that bracket ("never ship, so no package may
 * own them"), and swallowing the rest of the page would make every code on it "listed".
 */
export function neverShipsList(markdown: string): ReadonlySet<string> {
  const start = markdown.indexOf(NEVER_SHIPS_LEAD);
  if (start === -1) return new Set();
  const from = start + NEVER_SHIPS_LEAD.length;
  const close = markdown.indexOf(')', from);
  const span = markdown.slice(from, close === -1 ? from : close);
  return new Set([...span.matchAll(/`(X_[A-Z0-9_]*\*?)`/g)].map((match) => match[1] as string));
}

/**
 * A code with a real row. Anchored on `| \`X_…\` |` as the FIRST cell, so a code merely mentioned
 * inside another row's cause or fix does not count as having one of its own — which is exactly the
 * hole `documentedCodes`' whole-file regex leaves open.
 */
export const tableRows = (markdown: string): ReadonlySet<string> =>
  new Set(
    [...markdown.matchAll(/^\|\s*`(X_[A-Z0-9_]+)`\s*\|/gm)].map((match) => match[1] as string),
  );

export type GateCodeGapKind = 'no-row' | 'unlisted' | 'pinned';

export interface GateCodeGap {
  readonly kind: GateCodeGapKind;
  readonly code: string;
}

export interface GateCodeInput {
  /** Every `X_*` code declared under `scripts/`, from `collectDeclaredCodes`. */
  readonly declared: readonly string[];
  readonly page: string;
  readonly noRowPins: readonly string[];
  readonly unlistedPins: readonly string[];
}

/** A wildcard entry covers a family: `X_ROADMAP_*` stands for every code it prefixes. */
const covers = (listed: ReadonlySet<string>, code: string): boolean =>
  listed.has(code) ||
  [...listed].some((entry) => entry.endsWith('*') && code.startsWith(entry.slice(0, -1)));

export function checkGateCodes(input: GateCodeInput): readonly GateCodeGap[] {
  const listed = neverShipsList(input.page);
  const rows = tableRows(input.page);
  const gaps: GateCodeGap[] = [];

  const noRow = [...listed].filter((code) => !code.endsWith('*') && !rows.has(code));
  for (const code of noRow) {
    if (input.noRowPins.includes(code)) continue;
    gaps.push({ kind: 'no-row', code });
  }
  const unlisted = input.declared.filter((code) => !covers(listed, code));
  for (const code of unlisted) {
    if (input.unlistedPins.includes(code)) continue;
    gaps.push({ kind: 'unlisted', code });
  }
  // A pin nobody removes is a pin nobody reads — the ratchet only ratchets if it shrinks on its own.
  for (const code of input.noRowPins) {
    if (!noRow.includes(code)) gaps.push({ kind: 'pinned', code });
  }
  for (const code of input.unlistedPins) {
    if (!unlisted.includes(code)) gaps.push({ kind: 'pinned', code });
  }
  return gaps.sort((a, b) => a.code.localeCompare(b.code));
}

const FINDINGS: Readonly<Record<GateCodeGapKind, (code: string) => Finding>> = {
  'no-row': (code) => ({
    code: 'X_GATE_CODE_UNDOCUMENTED',
    cause: `${ERROR_REFERENCE} names ${code} in the never-ships list and gives it no table row, so an agent handed ${code} finds the name and no cause and no fix`,
    fix: `add a \`| \`${code}\` | … |\` row to ${ERROR_REFERENCE}, or drop ${code} from the never-ships list`,
    at: ERROR_REFERENCE,
  }),
  unlisted: (code) => ({
    code: 'X_GATE_CODE_UNDOCUMENTED',
    cause: `${code} is declared under scripts/ and ${ERROR_REFERENCE}'s never-ships list omits it, so that page promises "x errors explain ${code}" answers and it does not`,
    fix: `add \`${code}\` to the never-ships parenthesis in ${ERROR_REFERENCE}`,
    at: ERROR_REFERENCE,
  }),
  pinned: (code) => ({
    code: 'X_GATE_CODE_BACKLOG_STALE',
    cause: `${code} is pinned in ${BACKLOG_FILE} and ${ERROR_REFERENCE} is no longer wrong about it`,
    fix: `delete '${code}' from ${BACKLOG_FILE}`,
    at: BACKLOG_FILE,
  }),
};

export const gateCodeFinding = (gap: GateCodeGap): Finding => FINDINGS[gap.kind](gap.code);

/** Every `X_*` code this repo's own gate scripts declare — the set the parenthesis restates. */
export const scriptDeclaredCodes = async (root: string): Promise<readonly string[]> =>
  (await collectDeclaredCodes(root))
    .filter((site) => site.at.startsWith('scripts/'))
    .map((site) => site.code);

export const gateCodeGaps = async (root: string): Promise<readonly GateCodeGap[]> =>
  checkGateCodes({
    declared: await scriptDeclaredCodes(root),
    page: await Bun.file(`${root}/${ERROR_REFERENCE}`).text(),
    noRowPins: GATE_CODE_NO_ROW,
    unlistedPins: GATE_CODE_UNLISTED,
  });

/** Every finding this rule contributes, for a caller that folds it into a gate step. */
export const gateCodeFindings = async (root: string): Promise<readonly Finding[]> =>
  (await gateCodeGaps(root)).map(gateCodeFinding);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const pins = GATE_CODE_NO_ROW.length + GATE_CODE_UNLISTED.length;
  const findings = await gateCodeFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${ERROR_REFERENCE}'s never-ships list is complete in both directions, ${pins} code(s) pinned`
          : `${findings.length} finding(s): ${ERROR_REFERENCE}'s never-ships list is incomplete`,
      findings,
      data: { pinned: pins },
    },
    args.json,
  );
}
