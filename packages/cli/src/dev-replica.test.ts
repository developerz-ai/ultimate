// Read-replica routing is opt-in TWICE — a configured standby AND an open scope — and no booted
// process reached either. These are the two halves the boot now supplies, driven through
// `@ultimat3/db`'s own replicated client so every assertion is about which NODE a statement landed
// on rather than about which function was called.

import { describe, expect, test } from 'bun:test';
import type { DbClient } from '@ultimat3/db';
import { createRecordingClient, REPLICA_URL_ENV, replicatedClient, sql } from '@ultimat3/db';
import type { Middleware, RequestContext, UltimateRequest } from '@ultimat3/http';
import { attachReplica, replicaMiddleware, replicaOverrides, replicaUrlFor } from './dev-replica';
import type { ServiceBinding } from './dev-services';

const EXTERNAL: ServiceBinding = {
  name: 'db',
  mode: 'external',
  url: 'postgres://localhost:5432/app',
  detail: 'DATABASE_URL',
};

const EMBEDDED: ServiceBinding = {
  name: 'db',
  mode: 'embedded',
  url: 'pglite:///tmp/pgdata',
  detail: 'PGlite in this process',
};

const WITH_REPLICA = { [REPLICA_URL_ENV]: 'postgres://standby:5432/app' } as const;

/**
 * `compose()`'s contract with one frame, so the test runs the handler exactly where the pipeline
 * runs it — inside every middleware, in declaration order.
 */
const runThrough = async (
  middleware: readonly Middleware[],
  handler: () => Promise<void>,
): Promise<void> => {
  const inner = async (): Promise<Response> => {
    await handler();
    return new Response('');
  };
  const request = {} as UltimateRequest;
  const ctx = {} as RequestContext;
  const first = middleware[0];
  if (first === undefined) await inner();
  else await first(request, ctx, inner);
};

const routed = (): {
  primary: ReturnType<typeof createRecordingClient>;
  replica: ReturnType<typeof createRecordingClient>;
  client: DbClient;
} => {
  const primary = createRecordingClient();
  const replica = createRecordingClient();
  return { primary, replica, client: replicatedClient(primary, replica) };
};

describe('unit · which boots get a standby at all', () => {
  test('an external database with DATABASE_REPLICA_URL set', () => {
    expect(replicaUrlFor(EXTERNAL, WITH_REPLICA)).toBe('postgres://standby:5432/app');
  });

  // The half a homework app depends on: PGlite runs in this process and has no standby, so a
  // variable left over in a shell must not open a second pool beside it.
  test('an embedded database never does, whatever the environment says', () => {
    expect(replicaUrlFor(EMBEDDED, WITH_REPLICA)).toBeUndefined();
  });

  test('and neither does an external one with the variable unset or blank', () => {
    expect(replicaUrlFor(EXTERNAL, {})).toBeUndefined();
    expect(replicaUrlFor(EXTERNAL, { [REPLICA_URL_ENV]: '  ' })).toBeUndefined();
  });
});

describe('unit · with no replica configured, nothing changes', () => {
  test('the ambient client IS the primary — the same object, not a wrapper', () => {
    const primary = createRecordingClient();
    const attached = attachReplica(primary, undefined);
    expect(attached.client).toBe(primary);
    expect(attached.replica).toBeUndefined();
  });

  test('no middleware is installed, so no scope is entered per request', () => {
    expect(replicaMiddleware(EMBEDDED, WITH_REPLICA)).toEqual([]);
    expect(replicaMiddleware(EXTERNAL, {})).toEqual([]);
  });

  test("and the host's own overrides pass through as the very same value", () => {
    const overrides = { middleware: [] };
    expect(replicaOverrides(overrides, EXTERNAL, {})).toBe(overrides);
    expect(replicaOverrides(undefined, EXTERNAL, {})).toBeUndefined();
  });
});

describe('unit · with a replica configured, a request routes', () => {
  test('a read-only request reaches the replica — which needs the scope the boot opens', async () => {
    const { primary, replica, client } = routed();
    await runThrough(replicaMiddleware(EXTERNAL, WITH_REPLICA), async () => {
      await client.query(sql`select * from posts`);
    });
    expect(replica.texts).toEqual(['select * from posts']);
    expect(primary.texts).toEqual([]);
  });

  // The correctness half, and the reason the scope has to open OUTSIDE the handler: a write early
  // in a request pins every read after it to the primary.
  test('a request that writes and then reads reads the PRIMARY', async () => {
    const { primary, replica, client } = routed();
    await runThrough(replicaMiddleware(EXTERNAL, WITH_REPLICA), async () => {
      await client.execute(sql`insert into posts (id) values (${'p1'})`);
      await client.query(sql`select * from posts where id = ${'p1'}`);
    });
    expect(replica.texts).toEqual([]);
    expect(primary.texts).toHaveLength(2);
  });

  // Without a scope the same client is a single-pool one. This is the state the framework shipped
  // in: a configured replica that no process ever routed a statement to.
  test('the same client with no middleware routes nothing — the gap this closes', async () => {
    const { primary, replica, client } = routed();
    await runThrough([], async () => {
      await client.query(sql`select * from posts`);
    });
    expect(replica.texts).toEqual([]);
    expect(primary.texts).toEqual(['select * from posts']);
  });

  test('the scope frame is FIRST, so it opens outside anything a host installed', () => {
    const hostFrame: Middleware = (request, ctx, next) => next(request, ctx);
    const merged = replicaOverrides({ middleware: [hostFrame] }, EXTERNAL, WITH_REPLICA);
    expect(merged?.middleware).toHaveLength(2);
    expect(merged?.middleware?.at(-1)).toBe(hostFrame);
  });
});
