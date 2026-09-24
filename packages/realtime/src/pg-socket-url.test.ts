// Tests for `parsePgUrl`: the replication URL's parts, defaults, encodings and refusals — split
// from `pg-socket.test.ts`, which drives `pgStreamOver` against a hand-driven fake socket.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { ReplicationFailedError } from './errors';
import { parsePgUrl } from './pg-socket';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

describe('parsePgUrl', () => {
  test('parses a full URL: user, password, port, database, sslmode', () => {
    const target = parsePgUrl('postgres://alice:s3cret@db.example.test:6543/appdb?sslmode=require');
    expect(target).toEqual({
      host: 'db.example.test',
      port: 6543,
      database: 'appdb',
      user: 'alice',
      password: 's3cret',
      ssl: 'require',
    });
  });

  test('defaults: no port, no database, no user, no password, no sslmode', () => {
    const target = parsePgUrl('postgres://db.example.test');
    expect(target).toEqual({
      host: 'db.example.test',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: undefined,
      ssl: 'prefer',
    });
  });

  test('percent-encoded password and database are decoded', () => {
    const target = parsePgUrl('postgres://alice:p%40ss@db.example.test/my%20db');
    expect(target.password).toBe('p@ss');
    expect(target.database).toBe('my db');
  });

  test('postgresql: is accepted as a scheme', () => {
    expect(parsePgUrl('postgresql://db.example.test/db').host).toBe('db.example.test');
  });

  test('a non-postgres scheme or a non-URL string is X_REPLICATION_FAILED', () => {
    for (const bad of ['mysql://user:pass@host/db', 'not a url at all']) {
      const error = thrown(() => parsePgUrl(bad));
      expect(error).toBeInstanceOf(ReplicationFailedError);
      expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
    }
  });

  /**
   * The rejected value is a connection URL, so it carries the database password — and an error is
   * the one value that is rendered everywhere: a log line, `--json`, an agent's transcript, a
   * ticket. Name the variable that has to change, the way `driver-smtp.ts:68` does.
   */
  test('a malformed URL is refused without echoing the credential in it', () => {
    const error = thrown(() => parsePgUrl('postgres://alice:hunter2@:not-a-port/db'));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).toContain('DATABASE_URL');
  });

  test('an unknown sslmode is refused', () => {
    const error = thrown(() => parsePgUrl('postgres://db.example.test/db?sslmode=verify'));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
  });
});
