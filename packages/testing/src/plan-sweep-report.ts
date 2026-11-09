// The plan and scale sweeps, as `x exercise` reports them: one coded finding per statement no index
// serves (every primitive that sent it named) and per shape that grows with the rows, each with the
// edit that ends it — the `indexes:` entry read off the entity, or the `preload` — and one line each.

import { renderCauseValue, renderFixLiteral, renderFixShellArg } from '@ultimat3/core';
import type { ExerciseRecord } from './exercise-report';
import type { PlanUnservable } from './plan-sort-key';
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

/**
 * A read that compares no column of the table — a whole-table count, an unfiltered export — is
 * narrowed by no index: `on: []` is a line `x db gen` refuses. What ends it is saying why it may
 * read every row, around the call or on the entity, or giving it a condition.
 */
function wholeRead(finding: PlanFinding, senders: readonly ExerciseRecord[]): SweepFinding {
  const by = senders.map(primitive).join(', ');
  const entity = renderFixLiteral(finding.entity, '<entity>');
  const rerun = renderFixShellArg(senders[0]?.name ?? '', '<primitive>');
  return {
    code: finding.code,
    cause: `${by} sent ${renderCauseValue(excerpt(finding.statement))}, which reads ${finding.table} whole (${finding.node}) and compares no column of it: no index narrows it, so it slows with every row the table gains`,
    fix: `x exercise ${rerun} --json   # after expectedSeqScan('<why it reads every row>', fn) around the read, or scan: '<why it stays small>' in entity(${entity}), or a where clause that bounds it`,
    at: senders[0] === undefined ? finding.entity : primitive(senders[0]),
  };
}

/** Why no index serves a sort, as the cause says it. */
const UNSERVED_SORT: Readonly<Record<PlanUnservable, string>> = {
  expression: 'an expression over its columns, and entity() declares no expression index',
  aggregate: 'a value an aggregate or window computes, which no stored order holds',
  derived: 'a value a subquery or CTE derives, which no index on a table holds',
  tables: 'columns of more than one table, and one index holds one table',
  directions: 'columns in different directions, and an index declares one order for all of them',
};

/**
 * A red node no `indexes:` entry ends: a sort no declarable index holds, or one whose index the
 * entity already declares. Printing an index would change no plan, so the fix is the rewrite that
 * lets one apply, or the stated reason the rows stay few.
 */
function unservedRead(
  finding: PlanFinding,
  unserved: PlanUnservable | 'declared',
  senders: readonly ExerciseRecord[],
): SweepFinding {
  const by = senders.map(primitive).join(', ');
  const entity = renderFixLiteral(finding.entity, '<entity>');
  const rerun = renderFixShellArg(senders[0]?.name ?? '', '<primitive>');
  const sent = `${by} sent ${renderCauseValue(excerpt(finding.statement))}`;
  const cause =
    unserved === 'declared'
      ? `${sent}, which reads ${finding.table} unbounded (${finding.node}) though entity(${entity}) already declares the index that would bound it: declaring it again changes no plan, the statement as written cannot use it`
      : `${sent}, which sorts its rows to answer a limited read (${finding.node} under Limit) by ${UNSERVED_SORT[unserved]}: no index on ${finding.table} serves that sort, so it slows with every row the table gains`;
  const rewrite =
    unserved === 'declared'
      ? "the read compares the index's leading column by = or a range, no function around it"
      : `an order by of plain ${finding.table} columns, all one direction (the rerun names their index)`;
  return {
    code: finding.code,
    cause,
    fix: `x exercise ${rerun} --json   # after ${rewrite}, or expectedSeqScan('<why the rows stay few>', fn) around the read`,
    at: senders[0] === undefined ? finding.entity : primitive(senders[0]),
  };
}

function planFinding(finding: PlanFinding, senders: readonly ExerciseRecord[]): SweepFinding {
  if (finding.unserved !== undefined) return unservedRead(finding, finding.unserved, senders);
  if (finding.index.length === 0) return wholeRead(finding, senders);
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
      // An OR's arms are one finding each, on one statement: the index is part of what is red.
      const key = [finding.code, finding.table, finding.statement, ...finding.index].join('\u0000');
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
    ...(record.plans?.findings ?? []).map((finding) =>
      finding.unserved !== undefined
        ? `${primitive(record)} · ${finding.code} ${finding.table}, no index serves it (${finding.unserved})`
        : finding.index.length === 0
          ? `${primitive(record)} · ${finding.code} ${finding.table}, every row (no column to index)`
          : `${primitive(record)} · ${finding.code} ${finding.table} on [${finding.index.join(', ')}]`,
    ),
    ...(record.scale?.verdict === 'grows' ? record.scale.shapes : []).map(
      (shape) =>
        `${primitive(record)} · X_QUERY_SCALES_WITH_ROWS ${shape.fingerprint} ${shape.small}→${shape.large}`,
    ),
  ]);
}
