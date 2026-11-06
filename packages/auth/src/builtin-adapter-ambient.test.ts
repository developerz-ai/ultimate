// The adapter built with no client resolves the ambient `db()` on every call, never once at
// construction: a memoized `appAuth` built by the process's first caller must still follow a later
// `setDbClient` (a test's database, a branch database) and an open `withTransaction`.

import { afterEach, describe, expect, test } from 'bun:test';
import { recordingClient, setDbClient, withTransaction } from '@ultimat3/db';
import { postgresAuthAdapter } from './builtin-adapter';

afterEach(() => setDbClient(undefined));

describe('postgresAuthAdapter() — the ambient client, per call', () => {
  test('a client installed after the adapter was built is the one it reads', async () => {
    const first = recordingClient();
    const later = recordingClient();
    setDbClient(first);
    const adapter = postgresAuthAdapter();
    setDbClient(later);
    await adapter.findUserById('user-1');
    expect(first.texts).toEqual([]);
    expect(later.texts.at(-1)).toContain('select * from x_users where id = $1');
  });

  test('a call inside withTransaction joins the transaction, not the pool it was built on', async () => {
    const pool = recordingClient();
    const other = recordingClient();
    setDbClient(pool);
    const adapter = postgresAuthAdapter();
    await withTransaction(
      async () => {
        await adapter.findUserById('user-1');
      },
      { client: other },
    );
    expect(pool.texts).toEqual([]);
    const begin = other.texts.findIndex((text) => text.toLowerCase().startsWith('begin'));
    const read = other.texts.findIndex((text) => text.includes('from x_users'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(begin);
  });

  test('a client passed explicitly is pinned, whatever is installed later', async () => {
    const pinned = recordingClient();
    const installed = recordingClient();
    const adapter = postgresAuthAdapter(pinned);
    setDbClient(installed);
    await adapter.findUserById('user-1');
    expect(installed.texts).toEqual([]);
    expect(pinned.texts.at(-1)).toContain('from x_users');
  });
});
