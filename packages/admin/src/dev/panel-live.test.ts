/**
 * Pins how the live panel reads a failing subscriber source: "no sync node" is a diagnosis, not
 * a catch-all. A tier that was never installed is unwired; a tier that IS installed and broke
 * must keep its own code and fix line, because those are the two facts the reader needs.
 */

import { describe, expect, test } from 'bun:test';
import { DevSourceUnavailableError } from '../errors';
import type { DevSources, LiveQueryFact, LiveSubscriberFact } from './facts';
import type { DevPanel } from './panel';
import { panelPayload } from './panel';
import { livePanel } from './panel-live';

const QUERIES: readonly LiveQueryFact[] = [
  { name: 'inbox', live: true, policy: "can('inbox:read')", sql: 'select 1' },
  { name: 'archive', live: false, policy: "can('inbox:read')", sql: null },
];

/** Only the two members `livePanel` reads — the rest of `DevSources` is out of its scope. */
function sourcesFor(subscribers: () => Promise<readonly LiveSubscriberFact[]>): DevSources {
  return {
    liveQueries: (): Promise<readonly LiveQueryFact[]> => Promise.resolve(QUERIES),
    subscribers,
  } as DevSources;
}

describe('livePanel subscriber lookup', () => {
  test('an unwired sync node is a note, and the registered queries still render', async () => {
    const data = await livePanel.data(
      sourcesFor(() =>
        Promise.reject(new DevSourceUnavailableError({ source: 'subscribers', panel: 'live' })),
      ),
      new URLSearchParams(),
    );
    expect(data.note).toBe('dev.live.no-sync-node');
    expect(data.queries.map((query) => query.name)).toEqual(['inbox']);
    expect(data.idleQueries).toEqual(['inbox']);
  });

  test('a running node with nobody attached is not the same answer as no node', async () => {
    const data = await livePanel.data(
      sourcesFor(() => Promise.resolve([])),
      new URLSearchParams(),
    );
    expect(data.note).toBeNull();
    expect(data.idleQueries).toEqual(['inbox']);
  });

  test('any other failure keeps its own diagnostic instead of being retold as unwired', async () => {
    // The regression. A bare `catch` reported an authz refusal from a *running* node as "no sync
    // node" and dropped the code that said what to fix — the panel then told the reader to
    // install a tier they already had.
    const broken = Object.assign(new Error('nats: connection refused'), { code: 'X_FORBIDDEN' });
    const failure = await livePanel
      .data(
        sourcesFor(() => Promise.reject(broken)),
        new URLSearchParams(),
      )
      .catch((error: unknown) => error);
    expect(failure).toBe(broken);

    // What the reader gets instead of the note: `panelPayload` renders the code and the fix.
    const payload = await panelPayload(
      livePanel as DevPanel,
      sourcesFor(() => Promise.reject(broken)),
      new URLSearchParams(),
    );
    expect(payload.ok).toBe(false);
    expect(payload).toMatchObject({ error: { code: 'X_FORBIDDEN' } });
  });
});

const sub = (
  over: Partial<LiveSubscriberFact> & Pick<LiveSubscriberFact, 'id' | 'query' | 'matched'>,
): LiveSubscriberFact => ({
  actorId: 'u_1',
  trace: [],
  rows: 0,
  lastDeliveryAt: null,
  ...over,
});

const SUBSCRIBERS: readonly LiveSubscriberFact[] = [
  sub({ id: 's1', query: 'inbox', matched: true, rows: 3 }),
  sub({ id: 's2', query: 'inbox', matched: false, trace: ['tenant mismatch'] }),
  sub({ id: 's3', query: 'archive', matched: false, trace: ['not live'] }),
];

describe('livePanel with subscribers attached', () => {
  const attached = (params = ''): ReturnType<typeof livePanel.data> =>
    livePanel.data(
      sourcesFor(() => Promise.resolve(SUBSCRIBERS)),
      new URLSearchParams(params),
    );

  test('a query with somebody attached is not idle', async () => {
    const data = await attached();
    // `archive` is not `live`, so it never reaches `queries` and cannot be idle either.
    expect(data.queries.map((query) => query.name)).toEqual(['inbox']);
    expect(data.idleQueries).toEqual([]);
  });

  test('the rejected list keeps the matcher’s trace beside the subscriber it refused', async () => {
    const data = await attached();
    expect(data.rejected).toEqual([
      { id: 's2', query: 'inbox', trace: ['tenant mismatch'] },
      { id: 's3', query: 'archive', trace: ['not live'] },
    ]);
    // A matched subscriber is not a rejection — the panel's whole question is "why NOT".
    expect(data.rejected.map((entry) => entry.id)).not.toContain('s1');
  });

  test('?query= scopes the subscribers and the rejections with them', async () => {
    const data = await attached('query=archive');
    expect(data.subscribers.map((entry) => entry.id)).toEqual(['s3']);
    expect(data.rejected.map((entry) => entry.id)).toEqual(['s3']);
  });

  test('the idle list is computed BEFORE the ?query= filter, not after it', async () => {
    // Scoped to `archive`, nothing is attached to `inbox` in the filtered view — reporting it
    // idle would make the reader's own filter look like a client that never subscribed.
    const data = await attached('query=archive');
    expect(data.idleQueries).toEqual([]);
  });
});
