// The `subscribe` fixture is disposed with its test: the replicator it starts subscribes to the
// process-global `entity.row` / `entity.bulk` events, and a fixture value with no disposer left
// them subscribed for every later file — where a `countedIn` write then read its parents back, and
// a statement count one file over grew by one. Observable only across files, so in a child run.

import { expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { runFixtures } from './registry-guard-run-fixture';

const CORE = join(import.meta.dir, '..', '..', 'core', 'src', 'index.ts');
const TESTING = join(import.meta.dir, 'index.ts');

const QUERY = join(import.meta.dir, '..', '..', 'query', 'src');

/** One live query the node can serve: `liveNode()` refuses to start with none registered. */
const SUBSCRIBER = `import { afterAll, beforeAll, expect } from 'bun:test';
import { allow } from '${join(import.meta.dir, '..', '..', 'policy', 'src', 'index.ts')}';
import { from, query, resetQueries, t } from '${join(QUERY, 'index.ts')}';
import { registerQueries } from '${join(QUERY, 'loader.ts')}';
import { subscribed } from '${CORE}';
import { test } from '${TESTING}';

const liveRows = query({
  input: t.object({ orgId: t.uuid }),
  policy: allow('public'),
  live: true,
  sql: ({ orgId }) =>
    from<{ id: string; orgId: string }>('rows', async () => []).where({ orgId }).orderBy('id').limit(5),
});

beforeAll(() => registerQueries({ liveRows }));
afterAll(() => resetQueries());

test('builds the subscribe fixture, which subscribes to the row events', async ({ subscribe }) => {
  expect(typeof subscribe).toBe('function');
  expect(subscribed('entity.row')).toBe(true);
});
`;

const READER = `import { expect, test } from 'bun:test';
import { subscribed } from '${CORE}';

test('a later file starts with nobody listening to the row events', () => {
  expect([subscribed('entity.row'), subscribed('entity.bulk')]).toEqual([false, false]);
});
`;

test('the subscribe fixture unsubscribes its replicator when its test ends', async () => {
  const { output, exitCode } = await runFixtures({
    'a-subscriber.test.ts': SUBSCRIBER,
    'b-reader.test.ts': READER,
  });
  expect(output).toContain('2 pass');
  expect(exitCode).toBe(0);
}, 30_000);
