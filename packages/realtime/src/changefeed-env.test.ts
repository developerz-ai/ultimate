// The selection law, pinned: an unset variable means the embedded feed, a set one means a real
// WAL, and a replication URL that names a different database is refused rather than silently
// decoding a stream the app never writes to.

import { describe, expect, test } from 'bun:test';
import { InMemoryChangeFeed, PgLogicalReplicationFeed } from './changefeed';
import {
  DEFAULT_REPLICATION_PUBLICATION,
  DEFAULT_REPLICATION_SLOT,
  REPLICATION_ENV_KEYS,
  replicatorLockKey,
  selectChangeFeed,
} from './changefeed-env';

const APP_URL = 'postgres://app:secret@db.internal:5432/postly';
const REPL_URL = 'postgres://replicator:secret@db.internal:5432/postly';
const entities = ['posts', 'comments'];

describe('selectChangeFeed', () => {
  test('no connection string installs the in-process feed', () => {
    const selection = selectChangeFeed({}, { entities });
    expect(selection.feed).toBeInstanceOf(InMemoryChangeFeed);
    expect(selection.mode).toBe('embedded');
    expect(selection.slot).toBeNull();
    expect(selection.detail).toContain('DATABASE_URL');
  });

  test('an empty DATABASE_URL is the same as an unset one', () => {
    expect(selectChangeFeed({ DATABASE_URL: '   ' }, { entities }).mode).toBe('embedded');
  });

  test('DATABASE_URL installs the Postgres feed and reports the key that selected it', () => {
    const selection = selectChangeFeed({ DATABASE_URL: APP_URL }, { entities });
    expect(selection.feed).toBeInstanceOf(PgLogicalReplicationFeed);
    expect(selection.mode).toBe('external');
    expect(selection.detail).toBe('DATABASE_URL');
    expect(selection.slot).toBe(DEFAULT_REPLICATION_SLOT);
  });

  test('the detail never carries the credential in the URL', () => {
    const selection = selectChangeFeed({ DATABASE_URL: APP_URL }, { entities });
    expect(selection.detail).not.toContain('secret');
  });

  test('REPLICATION_URL wins over DATABASE_URL for the same database', () => {
    const selection = selectChangeFeed(
      { DATABASE_URL: APP_URL, REPLICATION_URL: REPL_URL },
      { entities },
    );
    expect(selection.mode).toBe('external');
    expect(selection.detail).toBe('REPLICATION_URL');
  });

  test('REPLICATION_URL alone selects the Postgres feed', () => {
    expect(selectChangeFeed({ REPLICATION_URL: REPL_URL }, { entities }).detail).toBe(
      'REPLICATION_URL',
    );
  });

  test('REPLICATION_SLOT and REPLICATION_PUBLICATION override the defaults', () => {
    const selection = selectChangeFeed(
      { DATABASE_URL: APP_URL, REPLICATION_SLOT: 'postly_slot', REPLICATION_PUBLICATION: 'pub_a' },
      { entities },
    );
    expect(selection.slot).toBe('postly_slot');
    expect(selection.feed.source).toBe('pg-logical-replication');
  });

  test('the defaults are the documented ones', () => {
    expect(DEFAULT_REPLICATION_SLOT).toBe('x_replicator');
    expect(DEFAULT_REPLICATION_PUBLICATION).toBe('x_changes');
  });

  test.each([
    ['a different database', 'postgres://replicator:x@db.internal:5432/other'],
    ['a different host', 'postgres://replicator:x@replica.internal:5432/postly'],
    ['a different port', 'postgres://replicator:x@db.internal:5433/postly'],
  ])('REPLICATION_URL naming %s is refused', (_label, url) => {
    expect(() =>
      selectChangeFeed({ DATABASE_URL: APP_URL, REPLICATION_URL: url }, { entities }),
    ).toThrow(/REPLICATION_URL names/);
  });

  test('the mismatch refusal is X_CONFIG_INVALID, not a bare error', () => {
    try {
      selectChangeFeed(
        { DATABASE_URL: APP_URL, REPLICATION_URL: 'postgres://r:x@db.internal:5432/other' },
        { entities },
      );
      expect.unreachable('a cross-database replication URL must be refused');
    } catch (error) {
      expect(error).toBeUltimateError('X_CONFIG_INVALID');
    }
  });

  test('a slot that is not a postgres identifier is refused at preflight', () => {
    expect(() =>
      selectChangeFeed({ DATABASE_URL: APP_URL, REPLICATION_SLOT: 'Bad Slot' }, { entities }),
    ).toThrow(/not a lower-case postgres identifier/);
  });

  test('an empty entity list is refused: no change could ever match', () => {
    expect(() => selectChangeFeed({ DATABASE_URL: APP_URL }, { entities: [] })).toThrow(
      /empty entity list/,
    );
  });

  test('the embedded feed still accepts an empty entity list — it decodes nothing', () => {
    expect(selectChangeFeed({}, { entities: [] }).mode).toBe('embedded');
  });

  test('REPLICATION_ENV_KEYS names every key the selector reads, and nothing else', () => {
    expect([...REPLICATION_ENV_KEYS]).toEqual([
      'DATABASE_URL',
      'REPLICATION_URL',
      'REPLICATION_SLOT',
      'REPLICATION_PUBLICATION',
    ]);
  });
});

describe('replicatorLockKey', () => {
  test('derives the key replicator.ts documents', () => {
    expect(replicatorLockKey('x_replicator')).toBe('x:replicator:x_replicator');
  });

  test('two slots on one server are two locks', () => {
    expect(replicatorLockKey('a')).not.toBe(replicatorLockKey('b'));
  });
});
