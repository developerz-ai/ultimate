// `x db diagnostics`' two renderings of one report: the terminal's tables and `--json`'s `data`,
// which must state the same facts — a section's rows, or its code, reason and fix.

import { describe, expect, test } from 'bun:test';
import type { DbDiagnostics } from '@ultimat3/db/diagnostics';
import { diagnosticsJson, renderDiagnostics } from './db-diagnostics';
import { msg } from './messages';

const empty = { available: true, rows: [] } as const;

const report: DbDiagnostics = {
  blockers: {
    available: true,
    rows: [
      {
        pid: 41,
        blockedBy: 7,
        waitEventType: 'Lock',
        waitEvent: 'relation',
        waitingSeconds: 3,
        query: 'alter table posts add column n int',
        blockerState: 'idle in transaction',
        blockerTransactionSeconds: 90,
        blockerQuery: null,
      },
    ],
  },
  activity: empty,
  slowQueries: {
    available: false,
    code: 'X_DB_SCHEMA_STALE',
    reason: 'relation "pg_stat_statements" does not exist',
    fix: 'create extension',
  },
  unusedIndexes: empty,
  invalidIndexes: empty,
  notValidConstraints: empty,
  deadTuples: empty,
};

describe('x db diagnostics rendering', () => {
  test('one heading per section, a table under each answered one, the fix under the rest', () => {
    const lines = renderDiagnostics(report);
    expect(lines[0]).toBe(msg('cli.db.diagnostics.section', { section: 'blockers', count: 1 }));
    expect(lines[1]?.trim().split(/\s+/).slice(0, 2)).toEqual(['pid', 'blockedBy']);
    expect(lines[2]?.trim().split(/\s+/).slice(0, 2)).toEqual(['41', '7']);
    expect(lines).toContain(
      msg('cli.db.diagnostics.unavailable', {
        section: 'slowQueries',
        code: 'X_DB_SCHEMA_STALE',
        reason: 'relation "pg_stat_statements" does not exist',
        fix: 'create extension',
      }),
    );
    expect(lines).toContain(msg('cli.db.diagnostics.section', { section: 'deadTuples', count: 0 }));
    expect(lines.join('\n')).not.toContain('⟦');
  });

  test('--json carries the report unchanged, nulls included', () => {
    expect(diagnosticsJson(report)).toEqual(JSON.parse(JSON.stringify(report)));
  });
});
