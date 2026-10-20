// `operator.ts`: the one runtime list the `Operator` type is derived from, the near-miss reading a
// fix names, and `checkedPredicate` — the line `andWhere` refuses on, before any driver runs.

import { describe, expect, test } from 'bun:test';
import { classifyThrown, registerErrorRetry } from '@ultimat3/core';
import { ENTITY_ERROR_RETRY } from './entity-error';
import {
  checkedPredicate,
  isOperator,
  OPERATORS,
  operatorMeant,
  operatorUnknown,
} from './operator';
import type { Operator } from './tenancy';

describe('OPERATORS', () => {
  test('is the type, at runtime: every member is an Operator and none repeats', () => {
    const typed: readonly Operator[] = OPERATORS;
    expect(new Set(typed).size).toBe(OPERATORS.length);
    for (const op of OPERATORS) expect(isOperator(op)).toBe(true);
  });

  test.each<unknown>(['>', 'GT', '', 'eq ', null, undefined, 1])('%p is not an operator', (op) => {
    expect(isOperator(op)).toBe(false);
  });
});

describe('operatorMeant', () => {
  test.each<[string, Operator]>([
    ['>', 'gt'],
    ['>=', 'gte'],
    ['<', 'lt'],
    ['<=', 'lte'],
    ['=', 'eq'],
    ['!=', 'neq'],
    ['<>', 'neq'],
    ['GT', 'gt'],
    ['is_null', 'is-null'],
    ['is not null', 'is-not-null'],
    [' Contained_By ', 'contained-by'],
  ])('%p means %p', (op, meant) => {
    expect(operatorMeant(op)).toBe(meant);
  });

  test.each<unknown>(['between', '~', 42, null])(
    '%p names nothing, so nothing is guessed',
    (op) => {
      expect(operatorMeant(op)).toBeUndefined();
    },
  );
});

describe('the refusal', () => {
  test('a near miss names the operator meant and the call with it substituted', () => {
    const error = operatorUnknown('posts', 'version', '>');
    expect(error.code).toBe('X_ENTITY_OPERATOR_UNKNOWN');
    expect(error.fix).toBe(
      `andWhere('version', 'gt', value)   # operators: ${OPERATORS.join(', ')}`,
    );
    expect(error.cause).toContain(
      "names '>', which is not an operator — the operator for it is 'gt'",
    );
  });

  test('terminal: a job does not spend its retry policy re-proving a typo', () => {
    // Re-registered: the table is process-wide, and another file's reset may have emptied it.
    registerErrorRetry(ENTITY_ERROR_RETRY);
    expect(classifyThrown(operatorUnknown('posts', 'version', '>'))).toBe('terminal');
  });

  test('nothing close: the whole list is the repair', () => {
    const error = operatorUnknown('posts', 'version', 'between');
    expect(error.fix).toBe(
      `andWhere('version', '<operator>', value)   # one of: ${OPERATORS.join(', ')}`,
    );
  });

  test('a column is quoted as the literal the call is written with', () => {
    expect(operatorUnknown('posts', "it's", '>').fix).toStartWith("andWhere('it\\'s', 'gt'");
  });

  test('a value that is not a string is rendered by type, never thrown on', () => {
    expect(operatorUnknown('posts', 'version', Symbol('op')).cause).toContain('Symbol(op)');
    expect(operatorUnknown('posts', 'version', 7n).cause).toContain('a bigint');
  });

  test('checkedPredicate refuses synchronously, on the line the author wrote', () => {
    expect(() => checkedPredicate('posts', 'version', '>', 1)).toThrow(
      expect.objectContaining({ code: 'X_ENTITY_OPERATOR_UNKNOWN' }),
    );
    expect(checkedPredicate('posts', 'version', 'gt', 1)).toEqual({
      column: 'version',
      op: 'gt',
      value: 1,
    });
  });
});
