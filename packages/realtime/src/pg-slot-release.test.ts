// A slot still held by the walsender before this one — a restart right behind a goodbye, a standby
// taking over — is waited for, bounded, before START_REPLICATION. It was asked for at once, and
// postgres refused with 55006 ("replication slot … is active for PID n").

import { expect, test } from 'bun:test';
import {
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  type ServerScript,
} from './pg-replication-fixture';
import { SLOT_RELEASE_POLLS } from './pg-slot-release';

const dial = async (script: ServerScript) => {
  ensurePostsEntity();
  const server = new FakeWalsender(script);
  const feed = feedOver(() => Promise.resolve(server), { fullIdentityTables: [] });
  await feed.start({ onChange: () => undefined });
  await feed.stop();
  const polls = server.queries.filter((sql) => sql.includes('pg_sleep'));
  const started = server.queries.findIndex((sql) => sql.startsWith('START_REPLICATION'));
  const lastPoll = server.queries.findLastIndex((sql) => sql.includes('pg_sleep'));
  return { polls, started, lastPoll };
};

test('a slot nobody holds costs no wait and no statement', async () => {
  const { polls, started } = await dial({});
  expect(polls).toHaveLength(0);
  expect(started).toBeGreaterThan(0);
});

test('a held slot is asked again until it is let go, and only then streamed from', async () => {
  // Held at preflight and for the next two asks; the third finds it free.
  const { polls, started, lastPoll } = await dial({ slotHeldFor: 3 });
  expect(polls).toHaveLength(3);
  expect(polls[0]).toContain("slot_name = 'ultimate_slot'");
  expect(started).toBeGreaterThan(lastPoll);
});

test('a slot that is never let go is asked a bounded number of times, then left to postgres', async () => {
  const { polls, started, lastPoll } = await dial({ slotHeldFor: Number.POSITIVE_INFINITY });
  expect(polls).toHaveLength(SLOT_RELEASE_POLLS);
  expect(started).toBeGreaterThan(lastPoll);
});
