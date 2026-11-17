#!/usr/bin/env bun
// Generate the index of `wiki/Error-Codes.md` from the owner pages (`wiki/Error-Codes-<owner>.md`)
// and refuse a committed index that has drifted from them, or a code row on a page its manifest
// owner does not hold.
//
// The reference was one 627 KB page of 1,358 rows under hand-picked theme headings; it is now one
// page per owner, and the index is the one place that lists every code. A hand-kept index would go
// stale on the first new code, so it is derived, and `--check` is the build error.
//
//   bun run scripts/error-code-pages.ts [--check | --write] [--json]

// why: Bun ships no path API; the root is joined with the host separator so Windows can open it.
import { join } from 'node:path';
import { flagBool, parseScriptArgs } from './lib/args';
import {
  INDEX_CLOSE,
  INDEX_OPEN,
  INDEX_WRITE,
  ownerName,
  renderIndex,
  withIndex,
} from './lib/error-code-index';
import type { ErrorCodePage } from './lib/error-code-pages';
import {
  codeRows,
  ERROR_CODE_INDEX,
  ownerOfPage,
  readErrorCodePages,
} from './lib/error-code-pages';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { siteAt } from './lib/site-at';

const SCRIPT = 'error-code-pages';
const WRITE = INDEX_WRITE;
const MANIFEST = 'framework.manifest.json';
const RESERVED_HEADING = '## Reserved codes';

export interface MisplacedRow {
  readonly code: string;
  /** `path:line`. */
  readonly at: string;
  readonly owner: string;
}

/**
 * Rows on a page their first code's manifest owner does not hold. On the index, only rows above
 * `## Reserved codes` count: the reserved table is the index's own and its codes have no owner.
 */
export function misplacedRows(
  pages: readonly ErrorCodePage[],
  owners: ReadonlyMap<string, string>,
): readonly MisplacedRow[] {
  return pages.flatMap((page) => {
    const pageOwner = ownerOfPage(page.path);
    const lines = page.text.split('\n');
    const reserved = lines.indexOf(RESERVED_HEADING);
    return codeRows(page.text).flatMap((row) => {
      const [code = ''] = row.codes;
      const owner = owners.get(code);
      if (owner === undefined || owner === pageOwner) return [];
      if (pageOwner === undefined && reserved !== -1 && row.line > reserved) return [];
      return [{ code, at: `${page.path}:${row.line}`, owner }];
    });
  });
}

/** Each declared code's owner, from the generated manifest; empty where there is none. */
async function manifestOwners(root: string): Promise<ReadonlyMap<string, string>> {
  const file = Bun.file(join(root, MANIFEST));
  if (!(await file.exists())) return new Map();
  const parsed: unknown = await file.json();
  const codes =
    typeof parsed === 'object' && parsed !== null && 'errorCodes' in parsed
      ? parsed.errorCodes
      : undefined;
  const owners = new Map<string, string>();
  if (!Array.isArray(codes)) return owners;
  for (const entry of codes as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { code, owner } = entry as { code?: unknown; owner?: unknown };
    if (typeof code === 'string' && typeof owner === 'string') owners.set(code, owner);
  }
  return owners;
}

/** The index as the owner pages generate it, or `undefined` when it has no block to fill. */
export async function generatedIndex(root: string): Promise<string | undefined> {
  const pages = await readErrorCodePages(root);
  const index = pages.find((page) => page.path === ERROR_CODE_INDEX)?.text ?? '';
  return withIndex(index, renderIndex(pages));
}

export async function errorCodeIndexFindings(root: string): Promise<readonly Finding[]> {
  const pages = await readErrorCodePages(root);
  const index = pages.find((page) => page.path === ERROR_CODE_INDEX)?.text ?? '';
  const generated = withIndex(index, renderIndex(pages));
  const findings: Finding[] = [];
  if (generated === undefined) {
    findings.push({
      code: 'X_ERROR_CODE_INDEX_STALE',
      cause: `${ERROR_CODE_INDEX} has no ${INDEX_OPEN} … ${INDEX_CLOSE} block, so the index of every code has nowhere to be written`,
      fix: `grep -n '${RESERVED_HEADING}' ${ERROR_CODE_INDEX}   # above that heading put the two lines ${INDEX_OPEN} and ${INDEX_CLOSE}, then: ${WRITE}`,
      at: ERROR_CODE_INDEX,
    });
  } else if (generated !== index) {
    findings.push({
      code: 'X_ERROR_CODE_INDEX_STALE',
      cause: `${ERROR_CODE_INDEX}'s generated index does not match the rows of the ${pages.length - 1} owner pages it is generated from`,
      fix: WRITE,
      at: ERROR_CODE_INDEX,
    });
  }
  for (const row of misplacedRows(pages, await manifestOwners(root))) {
    findings.push({
      code: 'X_ERROR_CODE_ROW_MISPLACED',
      cause: `${row.at} documents ${row.code}, which ${MANIFEST} says ${ownerName(row.owner)} owns, so a reader sent to wiki/Error-Codes-${row.owner}.md does not find it`,
      fix: `edit ${siteAt(row.at).path}:${siteAt(row.at).line} — move this row into wiki/Error-Codes-${row.owner}.md at its sorted place, then: ${WRITE}`,
      at: row.at,
    });
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    const next = await generatedIndex(root);
    if (next !== undefined) await Bun.write(join(root, ERROR_CODE_INDEX), next);
  }
  const findings = await errorCodeIndexFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${ERROR_CODE_INDEX}'s index matches its owner pages, and every row is on its owner's page`
          : `${findings.length} finding(s) on the error-code pages`,
      findings,
    },
    args.json,
  );
}
