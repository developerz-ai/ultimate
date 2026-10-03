// Two workers acquiring from ONE template at once, against a real Postgres. A clone outside the
// template's lock raced the next worker's migration: `CREATE DATABASE … TEMPLATE` waits 5 s for a
// session on the template to leave, then refuses — the first worker failed X_TEST_DATABASE_UNAVAILABLE.

import { describe, expect, test } from 'bun:test';
import type { SqlRunner, WorkerDatabase } from './template-db';
import { acquireWorkerDatabase, dropSql } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

/**
 * Two workers whose interleaving is forced by SIGNALS, never by a delay: a worker that reaches its
 * DROP after leaving the template's lock waits until the other worker's migration holds a session
 * on the template — the window a busy server opens. A worker that drops inside the lock never waits.
 * The migration holds its session past Postgres' 5 s wait (`pg_sleep(6)`, server-side).
 */
function race(): { migrate: (url: string) => Promise<void>; connect: (url: string) => SqlRunner } {
  let sessions = 0;
  let secondOpen: () => void = () => undefined;
  const bothOpen = new Promise<void>((resolve) => {
    secondOpen = resolve;
  });
  return {
    async migrate(url) {
      const sql = new Bun.SQL(url);
      try {
        await sql.unsafe('CREATE TABLE IF NOT EXISTS probe (id int)');
        sessions += 1;
        if (sessions === 2) secondOpen();
        await sql.unsafe('SELECT pg_sleep(6)');
      } finally {
        await sql.close();
      }
    },
    connect(url) {
      const sql = new Bun.SQL(url);
      let unlocked = false;
      return {
        exec: async (statement) => {
          if (statement.startsWith('DROP DATABASE') && unlocked) await bothOpen;
          await sql.unsafe(statement);
          if (statement.startsWith('SELECT pg_advisory_unlock')) unlocked = true;
        },
        close: () => sql.close(),
      };
    },
  };
}

describe.skipIf(adminUrl === '')('live · template-db under concurrent workers', () => {
  test('two workers acquiring at once both get their clone', async () => {
    const template = `ultimate_tpl_race_${process.pid}`;
    const { migrate, connect } = race();
    const acquire = (worker: number): Promise<WorkerDatabase> =>
      acquireWorkerDatabase(
        { adminUrl, templateName: template, migrate },
        { env: { ULTIMATE_TEST_WORKER: String(worker) }, connect },
      );
    const settled = await Promise.allSettled([acquire(1), acquire(2)]);
    const admin = new Bun.SQL(adminUrl);
    try {
      for (const each of settled) if (each.status === 'fulfilled') await each.value.drop();
      const refused = settled.flatMap((each) =>
        each.status === 'rejected' ? [(each.reason as { cause?: string }).cause ?? ''] : [],
      );
      expect(refused).toEqual([]);
    } finally {
      await admin.unsafe(dropSql(template));
      await admin.close();
    }
  }, 30_000);
});
