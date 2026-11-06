// The plan and scale sweeps, as `x exercise` reports them: one coded finding per statement no index
// serves (every primitive that sent it named) and per shape that grows with the rows, each with the
// edit that ends it — the `indexes:` entry read off the entity, or the `preload` — and one line each.

import { renderCauseValue, renderFixLiteral, renderFixShellArg } from '@ultimat3/core';
import type { ExerciseRecord } from './exercise-report';
import type { PlanFinding } from './plan-sweep-fix';

export interface SweepFinding {
  readonly code: 'X_QUERY_UNINDEXED' | 'X_QUERY_SORT_UNSERVED' | 'X_QUERY_SCALES_WITH_ROWS';
  readonly cause: string;
  readonly fix: string;
  /** The primitive, by kind and name: the registry records no declaring file. */
  readonly at: string;
}

const primitive = (record: ExerciseRecord): string => `${record.kind} ${record.name}`;

const STATEMENT_CHARS = 160;
const excerpt = (statement: string): string =>
  statement.length <= STATEMENT_CHARS ? statement : `${statement.slice(0, STATEMENT_CHARS)}…`;

/** `indexes: [{ on: ['orgId', 'authorId'] }]` — the line to paste into the entity. */
const indexLine = (finding: PlanFinding): string =>
  `indexes: [{ on: [${finding.index.map((p) => `'${p}'`).join(', ')}] }]`;

function planFinding(finding: PlanFinding, senders: readonly ExerciseRecord[]): SweepFinding {
  const by = senders.map(primitive).join(', ');
  const entity = renderFixLiteral(finding.entity, '<entity>');
  const name = renderFixShellArg(`${finding.table}-${finding.index.join('-')}-index`, '<name>');
  const what =
    finding.code === 'X_QUERY_SORT_UNSERVED'
      ? `sorts its rows to answer a limited read (${finding.node} under Limit)`
      : `reads ${finding.table} whole (${finding.node})`;
  const scan =
    finding.code === 'X_QUERY_UNINDEXED'
      ? `; or scan: '<why it stays small>' in that entity()`
      : '';
  return {
    code: finding.code,
    cause: `${by} sent ${renderCauseValue(excerpt(finding.statement))}, which ${what}: no index on ${finding.table} serves it, so it slows with every row the table gains`,
    fix: `x db gen ${name}   # after ${indexLine(finding)} in entity(${entity})${scan}`,
    at: senders[0] === undefined ? finding.entity : primitive(senders[0]),
  };
}

/** One finding per statement and red node, naming every primitive that sent it. */
export function planSweepFindings(records: readonly ExerciseRecord[]): readonly SweepFinding[] {
  const groups = new Map<string, { finding: PlanFinding; senders: ExerciseRecord[] }>();
  for (const record of records) {
    for (const finding of record.plans?.findings ?? []) {
      const key = `${finding.code}\u0000${finding.table}\u0000${finding.statement}`;
      const group = groups.get(key) ?? { finding, senders: [] };
      group.senders.push(record);
      groups.set(key, group);
    }
  }
  const plans = [...groups.values()].map(({ finding, senders }) => planFinding(finding, senders));
  const scale = records.flatMap((record): SweepFinding[] => {
    if (record.scale?.verdict !== 'grows') return [];
    const name = renderFixShellArg(record.name, '<primitive>');
    return record.scale.shapes.map((shape) => ({
      code: 'X_QUERY_SCALES_WITH_ROWS',
      cause: `${primitive(record)} sent ${renderCauseValue(shape.fingerprint)} ${shape.small}× at 2 rows a table and ${shape.large}× at 8: one statement per row, a loop no test named`,
      fix: `x exercise ${name} --json   # after preload() of the relation the loop reads, or expectedQueryLoop('<why>', fn) around a deliberate loop`,
      at: primitive(record),
    }));
  });
  return [...plans, ...scale];
}

/** One line per red: `action listPosts · X_QUERY_UNINDEXED posts on [orgId, authorId]`. */
export function planSweepLines(records: readonly ExerciseRecord[]): readonly string[] {
  return records.flatMap((record) => [
    ...(record.plans?.findings ?? []).map(
      (finding) =>
        `${primitive(record)} · ${finding.code} ${finding.table} on [${finding.index.join(', ')}]`,
    ),
    ...(record.scale?.verdict === 'grows' ? record.scale.shapes : []).map(
      (shape) =>
        `${primitive(record)} · X_QUERY_SCALES_WITH_ROWS ${shape.fingerprint} ${shape.small}→${shape.large}`,
    ),
  ]);
}
