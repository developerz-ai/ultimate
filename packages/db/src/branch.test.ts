// Single responsibility: `createBranch` and `reapBranches` against a recording client — no live
// Postgres needed, since neither statement's *result* depends on a real server, only its text and
// the caller-visible `now` default.

import { describe, expect, test } from 'bun:test';
import { createBranch, reapBranches } from './branch';
import { createRecordingClient } from './fake';

describe('createBranch', () => {
  test('omitting `now` still stamps createdAt with a valid, current timestamp', async () => {
    const client = createRecordingClient();
    const before = Date.now();
    const info = await createBranch('feature_x', { client, base: 'postgres' });
    const after = Date.now();

    const createdAtMs = Date.parse(info.createdAt ?? '');
    expect(Number.isNaN(createdAtMs)).toBe(false);
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });
});

describe('reapBranches', () => {
  test('omitting `now` still measures age against the current time, not the epoch', async () => {
    const client = createRecordingClient();
    const oldIso = new Date(Date.now() - 10_000).toISOString();
    client.on('pg_database', {
      rows: [{ name: 'stale', comment: `ultimate:branch:${oldIso}`, size_bytes: 0 }],
    });

    // maxAgeMs is well under the 10s the stubbed branch claims to be, so a `now` default that
    // silently fell back to something other than "now" (e.g. the epoch) would drop nothing.
    const dropped = await reapBranches({ client, maxAgeMs: 1_000 });
    expect(dropped).toEqual(['stale']);
  });
});
