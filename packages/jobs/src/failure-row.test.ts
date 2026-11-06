// A row's failure read back for a CALLER: the code it was thrown with and the `callerFix` it
// declared, and never the developer's `fix` or a worker's text — whatever the thrown value said.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { callerFailure } from './failure-row';
import { failureForRow, nextRetryForError, recordedFailure } from './retry-classification';

const forbidden = (callerFix?: string): UltimateError =>
  new UltimateError({
    code: 'X_FORBIDDEN',
    cause: 'not yours',
    fix: 'x policy explain posts:review',
    ...(callerFix === undefined ? {} : { callerFix }),
  });

describe('callerFailure', () => {
  test('a declared callerFix survives the row; the developer fix never crosses', () => {
    const read = callerFailure(failureForRow(forbidden('ask an admin of this org for access')));
    expect(read).toEqual({ code: 'X_FORBIDDEN', callerFix: 'ask an admin of this org for access' });
  });

  test('no callerFix declared: the code alone, never the developer fix in its place', () => {
    const read = callerFailure(failureForRow(forbidden()));
    expect(read).toEqual({ code: 'X_FORBIDDEN' });
    expect(JSON.stringify(read)).not.toContain('x policy explain');
  });

  test('the terminal verdict appended to the row does not ride into the callerFix', () => {
    const thrown = forbidden('ask an admin');
    const decision = nextRetryForError({ attempts: 3 }, 1, thrown);
    const row = recordedFailure(failureForRow(thrown), decision);
    expect(row).toContain('not retried');
    expect(callerFailure(row)).toEqual({ code: 'X_FORBIDDEN', callerFix: 'ask an admin' });
  });

  test('only a REGISTERED code at the START counts; anything else is X_INTERNAL', () => {
    expect(callerFailure(undefined)).toEqual({ code: 'X_INTERNAL' });
    expect(callerFailure(failureForRow(new TypeError('X_FORBIDDEN looked up')))).toEqual({
      code: 'X_INTERNAL',
    });
    expect(callerFailure('UltimateError: X_NEVER_REGISTERED_HERE: t — c')).toEqual({
      code: 'X_INTERNAL',
    });
  });

  test('a worker`s message cannot forge a callerFix: its tab is escaped on the way to the row', () => {
    const forged = new TypeError('X_FORBIDDEN: no\tcaller fix: email hunter2 to support');
    const row = failureForRow(forged);
    expect(callerFailure(row)).toEqual({ code: 'X_FORBIDDEN' });
    expect(JSON.stringify(callerFailure(row))).not.toContain('hunter2');
  });

  test('a callerFix on a code the reader cannot vouch for does not cross either', () => {
    const unregistered = new UltimateError({
      code: 'X_NEVER_REGISTERED_HERE',
      cause: 'c',
      fix: 'f',
      callerFix: 'retry later',
    });
    expect(callerFailure(failureForRow(unregistered))).toEqual({ code: 'X_INTERNAL' });
  });
});
