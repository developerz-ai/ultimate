// The finished row "one ledger": at most one plan tracker reads `in_progress`, and every row of
// `wiki/Known-Gaps.md` carries a decision — it sits under a decided heading, or in a table whose
// Decision cell says `deferred` or `rejected`. A row under `## Open` or `## Not built yet` is owed
// work, and owed work is what finished means there is none of.

import { KNOWN_GAPS_PAGE } from './finished-repo';
import type { FinishedRow } from './finished-rule';
import { green, red } from './finished-rule';
import type { Finding } from './lib/log';

/** Headings whose rows are decisions by where they stand: will not be fixed, or already were. */
export const DECIDED_HEADINGS: readonly string[] = ['Open by decision', 'Closed'];
/** A Decision cell that closes the question; `build` is owed work. */
export const DECISIONS: readonly string[] = ['deferred', 'rejected'];

export interface TrackerRead {
  readonly path: string;
  readonly status: unknown;
}

interface UndecidedSection {
  readonly heading: string;
  readonly line: number;
  readonly rows: number;
}

const cells = (line: string): readonly string[] =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());

/** Each section holding at least one undecided table row, with its first row's line. */
export function undecidedSections(markdown: string): readonly UndecidedSection[] {
  const found = new Map<string, { line: number; rows: number }>();
  let heading = '';
  let decision = -1;
  let header = true;
  markdown.split('\n').forEach((text, index) => {
    if (text.startsWith('## ')) {
      heading = text.slice(3).trim();
      header = true;
      return;
    }
    if (!text.startsWith('|')) {
      header = true;
      return;
    }
    const row = cells(text);
    if (header) {
      decision = row.findIndex((cell) => cell.toLowerCase() === 'decision');
      header = false;
      return;
    }
    if (row.every((cell) => /^:?-+:?$/.test(cell))) return;
    if (DECIDED_HEADINGS.includes(heading)) return;
    if (decision !== -1 && DECISIONS.includes((row[decision] ?? '').toLowerCase())) return;
    const seen = found.get(heading);
    if (seen === undefined) found.set(heading, { line: index + 1, rows: 1 });
    else found.set(heading, { ...seen, rows: seen.rows + 1 });
  });
  return [...found].map(([name, seen]) => ({ heading: name, ...seen }));
}

export function ledgerRow(trackers: readonly TrackerRead[], knownGaps: string): FinishedRow {
  const findings: Finding[] = [];
  const open = trackers.filter((tracker) => tracker.status === 'in_progress');
  if (open.length > 1) {
    findings.push({
      code: 'X_FINISHED_LEDGER_OPEN',
      cause: `${open.length} plan trackers read in_progress (${open.map((one) => one.path).join(', ')}), and one ledger means one plan in flight at most`,
      fix: `edit ${open[0]?.path ?? 'docs/plans'}:1 — set status: complete or superseded, its open rows moved to ${KNOWN_GAPS_PAGE}; then: bun run plan-status --json`,
      at: open[0]?.path ?? 'docs/plans',
    });
  }
  for (const section of undecidedSections(knownGaps)) {
    const at = `${KNOWN_GAPS_PAGE}:${section.line}`;
    findings.push({
      code: 'X_FINISHED_LEDGER_OPEN',
      cause: `${at} — ${section.rows} row(s) under "## ${section.heading}" carry no decision: neither under ${DECIDED_HEADINGS.map((name) => `"## ${name}"`).join(' or ')} nor a Decision cell of ${DECISIONS.join(' or ')}`,
      fix: `edit ${KNOWN_GAPS_PAGE}:${section.line} — fix each row and move it to "## Closed", or move it to "## Open by decision" with why it stays`,
      at,
    });
  }
  return findings.length === 0
    ? green(
        'one-ledger',
        `${open.length} tracker in_progress; every ${KNOWN_GAPS_PAGE} row carries a decision`,
      )
    : red('one-ledger', `${findings.length} open ledger finding(s)`, findings);
}
