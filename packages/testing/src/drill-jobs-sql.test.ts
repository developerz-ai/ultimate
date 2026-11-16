// `bunDrillSql`, the drill's direct line: a query against a database nothing serves rejects — it
// is never read as zero rows — and `close` releases a client that never connected. And the counts
// on their own clock and sleep: a stuck job is polled until it clears.

import { describe, expect, test } from 'bun:test';
import type { DrillSql } from './drill-jobs';
import { bunDrillSql, drillJobCounts, STUCK_SQL } from './drill-jobs';

/**
 * Port 1 (tcpmux): privileged, so no test process can listen there — a dial is refused every time,
 * where a port probed and released is one another process may be listening on by the dial.
 */
const REFUSED_PORT = 1;

describe('bunDrillSql', () => {
  test('a query no server answers rejects rather than counting nothing', async () => {
    const sql = bunDrillSql(`postgres://u:p@127.0.0.1:${String(REFUSED_PORT)}/x`);
    try {
      let outcome: unknown = 'resolved';
      try {
        await sql.rows(STUCK_SQL, [new Date(0)]);
      } catch (error) {
        outcome = error;
      }
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toMatch(/connect|refused|closed/i);
    } finally {
      await sql.close();
    }
  });
});

describe('drillJobCounts with the wall clock', () => {
  test('polls on its own sleep while a job is stuck, then counts', async () => {
    const stuck = [1, 1, 0];
    let asked = 0;
    const sql: DrillSql = {
      rows: async (text) => {
        if (text === STUCK_SQL) {
          asked += 1;
          return [{ n: stuck.shift() ?? 0 }];
        }
        return [{ n: 4 }];
      },
    };
    const counts = await drillJobCounts({ sql, since: new Date(0), settleMs: 10_000, pollMs: 1 });
    expect(counts).toEqual({ ran: 4, stuck: 0, doubled: 4 });
    expect(asked).toBe(3);
  });
});
