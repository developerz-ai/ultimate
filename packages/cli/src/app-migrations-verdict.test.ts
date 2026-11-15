// The app's ledger against the image's migrations: behind is what a role waits on, ahead is a
// rollback it serves through — and the ids come off one JSON column, refused into nothing else.

import { describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import {
  AppMigrationsUnappliedError,
  appMigrationsVerdict,
  parseAppliedIds,
  reportAppMigrationsAhead,
} from './app-migrations-verdict';

describe('unit · the app migrations verdict', () => {
  test('missing is what the build ships and the ledger lacks; unknown the reverse', () => {
    expect(appMigrationsVerdict(['0001_a', '0002_b'], ['0001_a', '0003_c'])).toEqual({
      missing: ['0002_b'],
      unknown: ['0003_c'],
    });
    expect(appMigrationsVerdict(['0001_a'], ['0001_a'])).toEqual({ missing: [], unknown: [] });
  });

  test('no ledger: every shipped migration is missing, nothing is unknown', () => {
    expect(appMigrationsVerdict(['0001_a', '0002_b'], undefined)).toEqual({
      missing: ['0001_a', '0002_b'],
      unknown: [],
    });
  });

  test('the ledger column is a JSON array of ids, and anything else is none', () => {
    expect(parseAppliedIds('["0001_a","0002_b"]')).toEqual(['0001_a', '0002_b']);
    expect(parseAppliedIds('[]')).toEqual([]);
    expect(parseAppliedIds('[1,"0001_a",null]')).toEqual(['0001_a']);
    expect(parseAppliedIds(null)).toEqual([]);
    expect(parseAppliedIds('{"id":"0001_a"}')).toEqual([]);
  });

  test('the refusal names five ids and counts the rest', () => {
    const missing = Array.from({ length: 8 }, (_, index) => `000${String(index)}_m`);
    const error = new AppMigrationsUnappliedError({ missing, ledger: true });
    expect(error.code).toBe('X_APP_MIGRATIONS_UNAPPLIED');
    expect(error.cause).toContain('0004_m and 3 more');
    expect(error.cause).not.toContain('0005_m');
    expect(error.cause).not.toContain('does not exist');
    expect(new AppMigrationsUnappliedError({ missing, ledger: false }).cause).toContain(
      'x_migrations does not exist',
    );
  });

  test('a ledger ahead is one warn line whose fix is a command that exists', () => {
    const lines: Record<string, unknown>[] = [];
    const release = installLogSink((line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    try {
      reportAppMigrationsAhead(['0003_c']);
      reportAppMigrationsAhead([]);
    } finally {
      release();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['fix']).toBe('x db migrate --json');
  });
});
