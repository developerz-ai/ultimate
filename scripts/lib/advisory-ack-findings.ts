// What the acknowledged-advisory ledger says of one audit: a row past its expiry while its range
// is still unfloorable, and a row that covers nothing the audit found. Pure: the verdicts and the
// rows arrive as values, so each finding is pinned by a fixture.

import type { AcknowledgedAdvisory } from './advisory-acknowledged';
import type { FloorVerdict } from './advisory-floors';
import { covers } from './advisory-floors';
import type { Finding } from './log';
import { acknowledgedKey, acknowledgedLine } from './pin-tables';

export const LEDGER = 'scripts/lib/advisory-acknowledged.ts';

const rowName = (row: AcknowledgedAdvisory): string =>
  `the ${row.dependency} row (${row.manifest})`;

/** `edit <ledger>:<the row's dependency line> — `: the shape a fix opens with, at the place to edit. */
const editAt = (row: AcknowledgedAdvisory | undefined, source: string): string => {
  const line =
    row === undefined
      ? 0
      : acknowledgedLine(source, acknowledgedKey(row.manifest, row.dependency, row.expires));
  return `edit ${LEDGER}:${line === 0 ? 1 : line} —`;
};

const atOf = (verdict: FloorVerdict): string =>
  `${verdict.declaration.manifest} ${verdict.declaration.field}.${verdict.declaration.name}`;

export function expiredFinding(
  verdict: Extract<FloorVerdict, { kind: 'expired' }>,
  source: string,
): Finding {
  const { name, range } = verdict.declaration;
  const lapsed = verdict.rows.map((row) => `${rowName(row)} expired ${row.expires}`).join('; ');
  return {
    code: 'X_ADVISORY_ACK_EXPIRED',
    at: atOf(verdict),
    cause: `${name}@${range} still admits ${verdict.exposures.map((e) => e.advisory).join(', ')} and no ${name} release floors them, but ${lapsed}: an acknowledgement is a decision with a date, and the date passed. If bun outdated shows a ${name} release that raises the floor, bump it and delete the row instead`,
    fix: `${editAt(verdict.rows[0], source)} re-date ${verdict.rows.map(rowName).join(', ')} at most 90 days out, with the reason it still stands`,
  };
}

/**
 * Every row naming an advisory the audit did not find on its declaration — the dependency floors it
 * now, the range became raisable, or the declaration is gone. A declaration the audit could not
 * judge is never evidence: its row is left alone.
 */
export function staleFindings(
  verdicts: readonly FloorVerdict[],
  rows: readonly AcknowledgedAdvisory[],
  source: string,
): Finding[] {
  return rows.flatMap((row): Finding[] => {
    const verdict = verdicts.find(
      (v) => v.declaration.manifest === row.manifest && v.declaration.name === row.dependency,
    );
    if (verdict?.kind === 'unknown') return [];
    const exposures =
      verdict?.kind === 'unfloorable' ||
      verdict?.kind === 'acknowledged' ||
      verdict?.kind === 'expired'
        ? verdict.exposures
        : [];
    const idle = row.advisories.filter(
      (id) =>
        verdict === undefined ||
        !exposures.some((e) => e.advisory === id && covers(row, verdict.declaration, e)),
    );
    if (idle.length === 0) return [];
    const why =
      verdict === undefined
        ? `${row.manifest} no longer declares ${row.dependency}`
        : verdict.kind === 'raise'
          ? `a floor closes ${row.dependency}'s range now (${verdict.to}), and a raise is never acknowledged`
          : `the audit no longer finds ${idle.join(', ')} through ${row.dependency}`;
    return [
      {
        code: 'X_ADVISORY_ACK_STALE',
        at: `${LEDGER} ${row.manifest} ${row.dependency}`,
        cause: `${rowName(row)} acknowledges ${idle.join(', ')}, which covers nothing: ${why}`,
        fix:
          idle.length === row.advisories.length
            ? `${editAt(row, source)} delete ${rowName(row)}`
            : `${editAt(row, source)} remove ${idle.join(', ')} from ${rowName(row)}`,
      },
    ];
  });
}
