// The replicator ensures its own publication: created FOR its entity tables when missing, extended
// by the tables it lacks when present, never shrunk — and refused with the paste-able statement
// when the connecting role may not do either. Driven by a scripted connection; the real-server
// half is `pg-replication.live.test.ts`.
import { describe, expect, test } from 'bun:test';
import { ReplicationFailedError } from './errors';
import type { PgRows } from './pg-connection';
import { ensurePublication } from './pg-publication';
import { REPLICATION_EXPOSURE_DOC } from './pg-wire';

interface Script {
  /** `undefined` = no publication by that name. */
  readonly members?: readonly string[];
  /** A statement starting with this prefix answers a server error. */
  readonly refuse?: string;
}

const scripted = (script: Script) => {
  const sent: string[] = [];
  return {
    sent,
    query(sql: string): Promise<PgRows> {
      sent.push(sql);
      if (script.refuse !== undefined && sql.startsWith(script.refuse)) {
        return Promise.reject(
          new ReplicationFailedError({
            stage: 'query',
            detail: '42501 — must be owner of table posts',
            fix: 'x doctor db',
          }),
        );
      }
      if (sql.includes('pg_publication_tables')) {
        return Promise.resolve((script.members ?? []).map((name) => [name]));
      }
      if (sql.includes('pg_publication')) {
        return Promise.resolve(script.members === undefined ? [] : [['1']]);
      }
      if (sql === 'SELECT current_user') return Promise.resolve([['app']]);
      return Promise.resolve([]);
    },
  };
};

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => expect.unreachable('ensurePublication resolved'),
    (error: unknown) => error,
  );

describe('ensurePublication', () => {
  test('a missing publication is created FOR every entity table, sorted, never FOR ALL TABLES', async () => {
    const connection = scripted({});
    const outcome = await ensurePublication(connection, 'x_changes', new Set(['users', 'posts']));
    expect(connection.sent).toContain('CREATE PUBLICATION x_changes FOR TABLE posts, users');
    expect(connection.sent.some((sql) => sql.includes('ALL TABLES'))).toBe(false);
    expect(outcome).toEqual({ created: true, added: ['posts', 'users'] });
  });

  test('a present publication gains only the entity tables it lacks', async () => {
    const connection = scripted({ members: ['posts', 'audit_log'] });
    const outcome = await ensurePublication(
      connection,
      'x_changes',
      new Set(['posts', 'users', 'comments']),
    );
    expect(connection.sent).toContain('ALTER PUBLICATION x_changes ADD TABLE comments, users');
    expect(connection.sent.some((sql) => sql.startsWith('CREATE PUBLICATION'))).toBe(false);
    expect(outcome).toEqual({ created: false, added: ['comments', 'users'] });
  });

  // An operator's own table in the publication is theirs; the replicator only ever adds.
  test('a complete publication is left alone — no ALTER, no DROP', async () => {
    const connection = scripted({ members: ['posts', 'audit_log'] });
    const outcome = await ensurePublication(connection, 'x_changes', new Set(['posts']));
    expect(connection.sent.some((sql) => /^(ALTER|DROP|CREATE)/.test(sql))).toBe(false);
    expect(outcome).toEqual({ created: false, added: [] });
  });

  test('a role that may not create it gets the refusal with the paste-able statement', async () => {
    const connection = scripted({ refuse: 'CREATE PUBLICATION' });
    const error = await failure(ensurePublication(connection, 'x_changes', new Set(['posts'])));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    const refused = error as ReplicationFailedError;
    expect(refused.code).toBe('X_REPLICATION_FAILED');
    expect(refused.cause).toContain('no publication named "x_changes" exists');
    expect(refused.cause).toContain('must be owner of table posts');
    expect(refused.fix).toStartWith('CREATE PUBLICATION x_changes FOR TABLE posts;');
    expect(refused.fix).toContain('ALTER ROLE "app" WITH REPLICATION;');
    expect(refused.fix).toContain(REPLICATION_EXPOSURE_DOC);
  });

  test('a role that may not extend it gets the ALTER to run as the tables owner', async () => {
    const connection = scripted({ members: ['posts'], refuse: 'ALTER PUBLICATION' });
    const error = await failure(
      ensurePublication(connection, 'x_changes', new Set(['posts', 'users'])),
    );
    const refused = error as ReplicationFailedError;
    expect(refused.code).toBe('X_REPLICATION_FAILED');
    expect(refused.cause).toContain('lacks users');
    expect(refused.fix).toStartWith('ALTER PUBLICATION x_changes ADD TABLE users;');
  });

  // A dead socket is not a privilege question: dressing it as "run this CREATE as the owner"
  // would send an operator to fix grants that were never the problem.
  test('a failure that is not a server refusal propagates unchanged', async () => {
    const dead = new TypeError('socket is already closed');
    const connection = {
      query: (sql: string): Promise<PgRows> =>
        sql.startsWith('CREATE') ? Promise.reject(dead) : Promise.resolve([]),
    };
    const error = await failure(ensurePublication(connection, 'x_changes', new Set(['posts'])));
    expect(error).toBe(dead);
  });

  test('a name outside [a-z_][a-z0-9_]* never reaches a statement', async () => {
    const connection = scripted({});
    const error = await failure(
      ensurePublication(connection, 'x_changes', new Set(['posts; drop table users'])),
    );
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect(connection.sent).toEqual([]);
  });
});
