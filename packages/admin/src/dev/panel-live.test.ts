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
