// Two workers acquiring from ONE template at once, against a real Postgres. A clone outside the
// template's lock raced the next worker's migration: `CREATE DATABASE … TEMPLATE` waits 5 s for a
// session on the template to leave, then refuses — the first worker failed X_TEST_DATABASE_UNAVAILABLE.

import { describe, expect, test } from 'bun:test';
import type { SqlRunner, WorkerDatabase } from './template-db';
import { acquireWorkerDatabase, dropSql } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

/**
 * A migration that holds a session on the template past Postgres' 5 s wait: a real migrator over
 * a large schema, or one stalled on a lock of its own.
 */
const slowMigrate = async (url: string): Promise<void> => {
  const sql = new Bun.SQL(url);
  try {
    await sql.unsafe('CREATE TABLE IF NOT EXISTS probe (id int)');
    await sql.unsafe('SELECT pg_sleep(6)');
  } finally {
    await sql.close();
  }
};

/**
 * Bun.SQL over one admin URL, with latency before the worker's own DROP: the time between leaving
 * the template's lock and starting the clone, which a busy server stretches. Made wide, not made up.
 */
const laggingConnect = (url: string): SqlRunner => {
  const sql = new Bun.SQL(url);
  return {
    exec: async (statement) => {
      if (statement.startsWith('DROP DATABASE')) await Bun.sleep(500);
      await sql.unsafe(statement);
    },
    close: () => sql.close(),
  };
};

describe.skipIf(adminUrl === '')('live · template-db under concurrent workers', () => {
  test('two workers acquiring at once both get their clone', async () => {
    const template = `ultimate_tpl_race_${process.pid}`;
    const acquire = (worker: number): Promise<WorkerDatabase> =>
      acquireWorkerDatabase(
        { adminUrl, templateName: template, migrate: slowMigrate },
        { env: { ULTIMATE_TEST_WORKER: String(worker) }, connect: laggingConnect },
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
