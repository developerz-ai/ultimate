// `realtime.maxSubscriptionsPerActor` reaches the live-query registry the `sync` role builds — a
// key that is validated and defaulted but never handed to the registry would be a knob with no
// wire, the defect `bun run scripts/config-readers.ts` exists to catch.

import { describe, expect, test } from 'bun:test';
import { defineConfig, userActor } from '@ultimat3/core';
import type { LiveQueryDefinition } from '@ultimat3/realtime/server';
import {
  DEFAULT_MAX_PER_ACTOR,
  formatLsn,
  SyncSocket,
  type WsLike,
} from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { registerLiveQueries, syncNodeCaps } from './role-sync';
import { REALTIME_DEFAULTS } from './runtime-realtime';

const ws: WsLike = {
  send: (data) => data.length,
  close() {},
  subscribe() {},
  unsubscribe() {},
  getBufferedAmount: () => 0,
};

const feed: LiveQueryDefinition = {
  name: 'capFeed',
  entities: ['posts'],
  async snapshot() {
    return { rows: [], lsn: formatLsn(1) };
  },
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

let n = 0;
const socket = (): SyncSocket => {
  n += 1;
  return new SyncSocket({
    ws,
    id: `cap-${String(n)}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'mallory', orgId: 'o1' }),
  });
};

const optionsWith = (maxSubscriptionsPerActor: number | undefined): StartRolesOptions =>
  ({
    buildId: 'b',
    runtime: { realtime: { ...REALTIME_DEFAULTS, maxSubscriptionsPerActor } },
  }) as unknown as StartRolesOptions;

const codeOf = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

describe('unit · the sync role hands realtime.maxSubscriptionsPerActor to its registry', () => {
  test('the configured ceiling is the one the registry enforces', async () => {
    const registry = registerLiveQueries(optionsWith(2)).register(feed);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(await codeOf(registry.subscribe({ socket: socket(), name: 'capFeed', input: i })));
    }
    expect(seen).toEqual(['ok', 'ok', 'X_SUBSCRIPTION_LIMIT']);
  });

  test("unset, the registry's own default applies — and core's defaults leave it unset", () => {
    expect(defineConfig({ name: 'app' }).realtime.maxSubscriptionsPerActor).toBeUndefined();
    expect(REALTIME_DEFAULTS.maxSubscriptionsPerActor).toBeUndefined();
    expect(DEFAULT_MAX_PER_ACTOR).toBe(1_000);
  });
});

describe('unit · the sync role hands realtime.maxSocketsPerActor to its node', () => {
  test('syncNodeCaps carries the configured socket ceiling, and nothing when unset', () => {
    expect(syncNodeCaps({ ...REALTIME_DEFAULTS, maxSocketsPerActor: 3 })).toEqual({
      maxSocketsPerActor: 3,
    });
    expect(syncNodeCaps(REALTIME_DEFAULTS)).toEqual({});
    expect(syncNodeCaps(undefined)).toEqual({});
    expect(REALTIME_DEFAULTS.maxSocketsPerActor).toBeUndefined();
  });
});
