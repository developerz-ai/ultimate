// The one rule `x db` and `x db branch` both turn a thrown value into a finding by. The split is
// the whole file: an error the migration engine named reaches the caller with ITS code and ITS
// fix, and anything else is renamed by the step that failed — never the other way round, which
// would replace `X_MIGRATION_IRREVERSIBLE`'s exact `--allow-destructive` line with `x doctor`.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL, UltimateError } from '@ultimat3/core';
import { stepFinding } from './db-finding';

describe('stepFinding', () => {
  test('a framework error keeps its own code, cause and fix', () => {
    const engine = new UltimateError({
      code: 'X_MIGRATION_IRREVERSIBLE',
      cause: '0007_drop_posts drops a column',
      fix: 'x db migrate --allow-destructive',
    });
    expect(stepFinding(engine, 'X_DB_MIGRATE_FAILED')).toMatchObject({
      code: 'X_MIGRATION_IRREVERSIBLE',
      cause: '0007_drop_posts drops a column',
      fix: 'x db migrate --allow-destructive',
    });
  });

  test('anything else is named by the step, with the raw message as the cause', () => {
    const finding = stepFinding(new Error('connection refused'), 'X_DB_GEN_FAILED');
    expect(finding).toEqual({
      code: 'X_DB_GEN_FAILED',
      cause: 'Error: connection refused',
      fix: 'x doctor --json',
      docs: ERROR_DOCS_URL,
    });
  });

  test('a non-Error throw is still rendered rather than lost', () => {
    // JSON-quoted by `renderThrowable`: a bare string cause and a string-valued message are two
    // different facts, and the quotes are what keeps them apart.
    expect(stepFinding('boom', 'X_DB_BRANCH_FAILED').cause).toBe('"boom"');
    expect(stepFinding(undefined, 'X_DB_BRANCH_FAILED').code).toBe('X_DB_BRANCH_FAILED');
  });

  test('an Error whose message throws cannot take the report down with it', () => {
    // The reason `renderThrowable` is used here rather than `String(error)`: a value the engine
    // handed over may be hostile, and the refusal must survive being reported.
    const hostile = Object.defineProperty(new Error('x'), 'message', {
      get: () => {
        throw new Error('gotcha');
      },
    });
    const finding = stepFinding(hostile, 'X_DB_MIGRATE_FAILED');
    expect(finding.code).toBe('X_DB_MIGRATE_FAILED');
    expect(finding.cause.length).toBeGreaterThan(0);
  });
});
