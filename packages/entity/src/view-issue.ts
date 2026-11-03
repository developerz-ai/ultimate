// Single responsibility: one `$view` key's refusal as a schema issue — its path, a rule from the
// column's own fact and the column's own sentence — so a form binds it to the field it names.
// Split from `view.ts` so the projection stays one job.

import { renderThrowable, stringField } from '@ultimat3/core';
import type { SchemaNode, StandardIssue } from '@ultimat3/schema';
import type { AnyColumn } from './types';

/** `refuseColumn`'s cause: `column.<rule>: <sentence>`. */
const COLUMN_CAUSE = /^column\.([a-z-]+): (.+)$/s;

/** The rule a column fact names, from `@ultimat3/schema`'s `SCHEMA_RULES`. */
function ruleOf(
  column: AnyColumn,
  node: SchemaNode,
  refused: string | undefined,
): Pick<StandardIssue, 'rule' | 'params'> {
  const meta = column.$meta;
  if (refused === 'length' && meta.length !== undefined) {
    return { rule: 'string.max', params: { max: meta.length } };
  }
  if (meta.values !== undefined)
    return { rule: 'enum', params: { values: meta.values.join(' | ') } };
  return { rule: 'type', params: { type: node.kind } };
}

/** A required column with nothing at its key: missing data, never a value the view may invent. */
export function missingIssue(key: string): StandardIssue {
  return { path: [key], message: 'is required', rule: 'required' };
}

/**
 * What a column's `$parse` threw, at `[key]`. The sentence is the column's own (`expected at most
 * 200 characters, got 300`) — never the whole `X_INVARIANT_VIOLATED` line, which names the column
 * a second time and reads as a server fault. A throwable that is not the column's refusal is
 * rendered whole, through `renderThrowable`, which is total.
 */
export function columnIssue(
  key: string,
  column: AnyColumn,
  node: SchemaNode,
  error: unknown,
): StandardIssue {
  const match = COLUMN_CAUSE.exec(stringField(error, 'cause') ?? '');
  const message = match?.[2] ?? renderThrowable(error);
  return { path: [key], message, ...ruleOf(column, node, match?.[1]) };
}
