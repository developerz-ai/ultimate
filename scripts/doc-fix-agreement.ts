#!/usr/bin/env bun
// Enforce, on `x verify`'s `errors` step, that `wiki/Error-Codes.md`'s Fix cell and the `fix:` its
// code's throw sites register name the same remedy. The page drifted from the source with nothing
// red: `X_ACTION_UNREGISTERED` / `X_QUERY_UNREGISTERED` named a call the source no longer did.
//
//   bun run scripts/doc-fix-agreement.ts [--json]

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { scanScopeFixes } from '../packages/cli/src/error-fixes';
import { readFixCells } from './doc-fixes';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'doc-fix-agreement';
const PAGE = 'wiki/Error-Codes.md';

/**
 * Disagreements the page carries today, a ratchet that may only fall. `As of 2026-11-10`, 22 rows:
 * most are a GENERAL row over a code raised at many dynamic sites (`X_INVARIANT`'s six,
 * `X_CONFIG_INVALID`'s 23), where the page states the class of remedy and each site its instance;
 * a few are a row ahead of a stale site (`X_RPC_FAILED`'s site is thrown by nothing since 21.0.0).
 * Agreeing one lowers this by one in the same diff; `X_DOC_FIX_DISAGREES_PIN_STALE` says when.
 */
export const DISAGREEMENT_PIN = 21;

/** One site's registered fix; `undefined` when the site builds it at run time. */
export interface RegisteredFix {
  readonly fix?: string;
}

/**
 * What a fix tells a reader to TOUCH: a command, a call, a file, an environment name. Wording,
 * backticks, `<placeholder>` spellings and order are formatting; these are the remedy.
 */
export function fixAnchors(text: string): ReadonlySet<string> {
  const plain = text.replace(/`/g, ' ').replace(/<[^>\s]+>/g, '<value>');
  const anchors = new Set<string>();
  // `name(` with no space: "the first page (after: null)" is prose, `defineApi(` is a call.
  for (const [, name] of plain.matchAll(/\b([A-Za-z_$][\w$]*)\(/g)) anchors.add(`${name}()`);
  for (const [, command] of plain.matchAll(
    /(?:^|[\s(;])((?:bun run|bunx|bun add|bun update|x|gh|npm|docker|kubectl|git)\s+[a-z][\w:-]*)/g,
  )) {
    anchors.add((command ?? '').replace(/\s+/g, ' '));
  }
  for (const [path] of plain.matchAll(
    /[\w@.-]*\/[\w./<>@-]+\.(?:ts|tsx|json|ya?ml|md|sh|sql)\b/g,
  )) {
    anchors.add(path.split('/').pop() ?? path);
  }
  for (const [name] of plain.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) {
    if (!name.startsWith('X_')) anchors.add(name);
  }
  return anchors;
}

export interface FixDisagreement {
  readonly code: string;
  readonly line: number;
  readonly doc: readonly string[];
  readonly source: readonly string[];
}

/**
 * Rows whose anchors share NOTHING with any site's. A row or a site set with no anchor at all
 * ("fix the failure named in the cause") has nothing to compare and is no verdict either way.
 */
export function checkFixAgreement(
  markdown: string,
  sites: ReadonlyMap<string, readonly RegisteredFix[]>,
): readonly FixDisagreement[] {
  const gaps: FixDisagreement[] = [];
  for (const cell of readFixCells(markdown)) {
    const registered = new Set(
      (sites.get(cell.code) ?? []).flatMap((site) =>
        site.fix === undefined ? [] : [...fixAnchors(site.fix)],
      ),
    );
    const documented = fixAnchors(cell.fix);
    if (registered.size === 0 || documented.size === 0) continue;
    if ([...documented].some((anchor) => registered.has(anchor))) continue;
    gaps.push({
      code: cell.code,
      line: cell.line,
      doc: [...documented],
      source: [...registered],
    });
  }
  return gaps;
}

/** The ratchet: red above the pin with every disagreement listed, red below it on the pin. */
export function agreementFindings(gaps: readonly FixDisagreement[]): readonly Finding[] {
  if (gaps.length > DISAGREEMENT_PIN) {
    return gaps.map((gap) => ({
      code: 'X_DOC_FIX_DISAGREES',
      cause: `${PAGE}:${gap.line} tells ${gap.code}'s reader to touch ${gap.doc.join(', ')}; its throw sites register ${gap.source.join(', ')} — no remedy in common. ${gaps.length} rows disagree, pinned at ${DISAGREEMENT_PIN}`,
      fix: `bun run x -- errors explain ${renderFixShellArg(gap.code, '<CODE>')} --json   # the registered fix; rewrite the Fix cell at ${PAGE}:${gap.line} to name it, or correct the throw site's fix: if the page is the right one`,
      at: `${PAGE}:${gap.line}`,
    }));
  }
  if (gaps.length < DISAGREEMENT_PIN) {
    return [
      {
        code: 'X_DOC_FIX_DISAGREES_PIN_STALE',
        cause: `${gaps.length} ${PAGE} rows disagree with their registered fix and DISAGREEMENT_PIN in scripts/doc-fix-agreement.ts still allows ${DISAGREEMENT_PIN}, so a new disagreement could land unseen`,
        fix: `grep -n 'DISAGREEMENT_PIN =' scripts/doc-fix-agreement.ts   # set it to ${gaps.length}`,
        at: 'scripts/doc-fix-agreement.ts',
      },
    ];
  }
  return [];
}

export async function docFixAgreementGaps(root: string): Promise<readonly FixDisagreement[]> {
  const page = Bun.file(join(root, PAGE));
  if (!(await page.exists())) return [];
  return checkFixAgreement(await page.text(), await scanScopeFixes(join(root, 'packages')));
}

/** A root with no page makes no claim: a fixture tree, never this repository's. */
export const docFixAgreementFindings = async (root: string): Promise<readonly Finding[]> =>
  agreementFindings(await docFixAgreementGaps(root));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await docFixAgreementGaps(repoRoot());
  const findings = agreementFindings(gaps);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary: `${gaps.length} ${PAGE} Fix cell(s) name no remedy their throw sites register (pin ${DISAGREEMENT_PIN})`,
      findings,
      data: { disagreements: gaps },
    },
    args.json,
  );
}
