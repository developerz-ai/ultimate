// Single responsibility: the span one statement is. Named `db.<verb>` because `x dev`'s recorder
// reads the panel's kind off the prefix, exactly as it does for `query.`, `cache.` and `job.`, and
// carrying the text as `db.statement` — the attribute the timeline groups on to count an N+1. It is
// opened on the observed path only, so a process with no diagnostic installed traces what it did
// before the seam existed.

import { withSpan } from '@ultimat3/core';
import { statementVerb } from './statement-shape';

/**
 * OTel's name for the statement itself. Exported because it is a contract across two packages, not
 * a local constant: `packages/cli/src/dev-traces.ts` reads it as a span's detail, so a rename that
 * only landed here would leave the timeline grouping span names again with every test still green.
 */
export const STATEMENT_ATTRIBUTE = 'db.statement';

/**
 * `db.select`, `db.insert`, `db.begin` — low cardinality on purpose, so the flame reads at a glance
 * and a trace backend can still aggregate by name. The full text rides on the span, never in it.
 *
 * The verb is `statement-shape.ts`'s, the same read the N+1 detectors classify a statement with: a
 * text with no leading word is `db.statement` here and a read there, one scanner and two labels.
 */
export function statementSpanName(text: string): string {
  const verb = statementVerb(text);
  return `db.${verb === '' ? 'statement' : verb}`;
}

/**
 * Wraps the send, so the span's duration is the statement's and a failure is recorded on it rather
 * than inferred from the gap after it. `client` is the OTel kind — the database is the remote peer;
 * the panel's own `sql` kind comes off the name prefix, since `db` is tier 1 and cannot name a
 * tier-5 vocabulary.
 */
export function withStatementSpan<T>(text: string, send: () => Promise<T>): Promise<T> {
  return withSpan(statementSpanName(text), send, {
    kind: 'client',
    attributes: { [STATEMENT_ATTRIBUTE]: text },
  });
}
