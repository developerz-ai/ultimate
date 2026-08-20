// Single responsibility: `createBranch` and `reapBranches` against a recording client — no live
// Postgres needed, since neither statement's *result* depends on a real server, only its text and
// the caller-visible `now` default.

import { describe, expect, test } from 'bun:test';
import { createBranch, dropBranch, listBranches, reapBranches } from './branch';
import { createRecordingClient } from './fake';

/** The marker as it is written now: the base this clone came from, then the instant, in UTC. */
const marker = (base: string, createdAt: string): string => `ultimate:branch:${base}:${createdAt}`;

const staleIso = (): string => new Date(Date.now() - 10_000).toISOString();

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

  test('the comment records what the branch was cloned FROM, and so does the answer', async () => {
    // `pg_database` records no template lineage and `datdba` is shared when both apps use one
    // role, so the base is written down at creation or it is not knowable afterwards at all.
    const client = createRecordingClient();
    const info = await createBranch('feature_x', {
      client,
      base: 'shop',
      now: new Date('2026-08-19T10:00:00.000Z'),
    });

    expect(info.base).toBe('shop');
    expect(
      client.texts.some((text) => text.includes(`'ultimate:branch:shop:2026-08-19T10:00:00.000Z'`)),
    ).toBe(true);
  });
});

describe('listBranches', () => {
  test('reads the two segments apart, and an old one-segment comment as no base', async () => {
    const client = createRecordingClient();
    client.on('pg_database', {
      rows: [
        { name: 'new', comment: marker('shop', '2026-08-19T10:00:00.000Z'), size_bytes: 0 },
        { name: 'old', comment: 'ultimate:branch:2026-08-19T10:00:00.000Z', size_bytes: 0 },
      ],
    });

    // The date survives on a pre-3.x branch — `x db branch ls` still shows it — and the base
    // does not, because nothing ever wrote one. Unknown, never guessed at.
    expect(await listBranches({ client })).toEqual([
      {
        name: 'new',
        base: 'shop',
        createdAt: '2026-08-19T10:00:00.000Z',
        sizeBytes: 0,
      },
      {
        name: 'old',
        base: null,
        createdAt: '2026-08-19T10:00:00.000Z',
        sizeBytes: 0,
      },
    ]);
  });
});

describe('reapBranches', () => {
  test('omitting `now` still measures age against the current time, not the epoch', async () => {
    const client = createRecordingClient();
    const oldIso = new Date(Date.now() - 10_000).toISOString();
    client.on('pg_database', {
      rows: [{ name: 'stale', comment: marker('postgres', oldIso), size_bytes: 0 }],
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
        { name: 'truncated', comment: marker('postgres', '2026-01-0'), size_bytes: 0 },
        { name: 'empty', comment: marker('postgres', ''), size_bytes: 0 },
        { name: 'stale', comment: marker('postgres', staleIso()), size_bytes: 0 },
      ],
    });

    const dropped = await reapBranches({ client, maxAgeMs: 1_000 });

    expect(dropped).toEqual(['stale']);
    expect(
      client.texts.some((text) => text.includes('drop database') && text.includes('truncated')),
    ).toBe(false);
  });

  /**
   * `Number.isFinite` is not the whole guard, because truncation does not always reach `NaN`:
   * `'2020-01-01T00:00'` parses fine — as *local* time, an instant up to 14 hours from the one
   * the string reads as, and never one `createBranch` wrote. `toISOString()` is the only writer
   * (`branch.ts`), so a comment that does not round trip through it is not the framework's, and
   * the reaper leaves it alone rather than acting on a date nobody wrote.
   */
  test('a finite but non-canonical createdAt is skipped too, not reaped on a date nobody wrote', async () => {
    const client = createRecordingClient();
    client.on('pg_database', {
      rows: [
        // Both parse, both are finite, and both are far older than the cutoff — so the finite
        // check alone drops them, and only the round trip spares them.
        { name: 'truncated_local', comment: marker('postgres', '2020-01-01T00:00'), size_bytes: 0 },
        { name: 'no_millis', comment: marker('postgres', '2020-01-01T00:00:00Z'), size_bytes: 0 },
        { name: 'stale', comment: marker('postgres', staleIso()), size_bytes: 0 },
      ],
    });

    const dropped = await reapBranches({ client, maxAgeMs: 1_000 });

    expect(dropped).toEqual(['stale']);
    expect(client.texts.some((text) => text.includes('drop database'))).toBe(true);
    expect(
      client.texts.some((text) => text.includes('drop database') && !text.includes('"stale"')),
    ).toBe(false);
  });
});

describe('reapBranches is a sweep of THIS database, not of the server', () => {
  /**
   * Issue #133. `listBranches` walks `pg_database` for the whole server and admits every database
   * carrying the marker, so two Ultimate apps on one Postgres plus one nightly reap is the other
   * app's branches dropped — a `DROP DATABASE` nothing recovers from and nobody asked for.
   */
  test('a branch of another database on the same server is never dropped', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'shop' }] });
    client.on('pg_database', {
      rows: [
        { name: 'shop_branch_feat', comment: marker('shop', staleIso()), size_bytes: 0 },
        { name: 'analytics_branch_feat', comment: marker('analytics', staleIso()), size_bytes: 0 },
      ],
    });

    const dropped = await reapBranches({ client, maxAgeMs: 1_000 });

    expect(dropped).toEqual(['shop_branch_feat']);
    expect(client.texts.some((text) => text.includes('analytics_branch_feat'))).toBe(false);
  });

  /**
   * The safe direction, and it is what makes the change need no migration: a comment written
   * before the base was recorded reads as a branch of nothing, and a branch of nothing is not a
   * branch of this database. The next `x db branch create` writes the two-segment form.
   */
  test('a pre-3.x one-segment marker is skipped, never dropped', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'shop' }] });
    client.on('pg_database', {
      rows: [{ name: 'legacy', comment: `ultimate:branch:${staleIso()}`, size_bytes: 0 }],
    });

    expect(await reapBranches({ client, maxAgeMs: 1_000 })).toEqual([]);
    expect(client.texts.some((text) => text.includes('drop database'))).toBe(false);
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
