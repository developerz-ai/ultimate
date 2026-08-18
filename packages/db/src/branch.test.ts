// Single responsibility: `createBranch` and `reapBranches` against a recording client — no live
// Postgres needed, since neither statement's *result* depends on a real server, only its text and
// the caller-visible `now` default.

import { describe, expect, test } from 'bun:test';
import { createBranch, dropBranch, reapBranches } from './branch';
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

  /**
   * A comment truncated by `pg_database.description`'s own limits, or hand-edited, parses to
   * `NaN` — and `NaN > cutoff` is `false`, which is the same answer "older than the cutoff"
   * gives. So an unreadable timestamp did not merely lose its age: it reaped the database on the
   * next nightly sweep, `maxAgeMs` notwithstanding. An age nothing can read is not an old age.
   */
  test('an unparseable createdAt is skipped, not read as infinitely old', async () => {
    const client = createRecordingClient();
    client.on('pg_database', {
      rows: [
        { name: 'truncated', comment: 'ultimate:branch:2026-01-0', size_bytes: 0 },
        { name: 'empty', comment: 'ultimate:branch:', size_bytes: 0 },
        {
          name: 'stale',
          comment: `ultimate:branch:${new Date(Date.now() - 10_000).toISOString()}`,
          size_bytes: 0,
        },
      ],
    });

    const dropped = await reapBranches({ client, maxAgeMs: 1_000 });

    expect(dropped).toEqual(['stale']);
    expect(
      client.texts.some((text) => text.includes('drop database') && text.includes('truncated')),
    ).toBe(false);
  });
});

/**
 * The boolean answers "was there a branch here?", which is the only question a reaper or a preview
 * teardown asks it. `drop database if exists` reports the same command tag either way, so
 * `affected >= 0` was `true` by construction — a constant dressed as a result.
 */
describe('dropBranch', () => {
  test('a branch that existed answers true; a name that was never a database answers false', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'postgres' }] });

    client.on('from pg_database where datname', { rows: [{ ok: 1 }] });
    expect(await dropBranch('feature_x', { client })).toBe(true);

    client.on('from pg_database where datname', { rows: [] });
    expect(await dropBranch('feature_x', { client })).toBe(false);

    // The statement still went out both times: `if exists` is what makes the second call safe.
    expect(client.texts.filter((text) => text.includes('drop database'))).toHaveLength(2);
  });
});
