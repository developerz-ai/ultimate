// Where a dial says it resumed. Postgres forwards a START_REPLICATION older than the slot's
// confirmed position to that position, so a resume claimed below it promises changes nobody will
// send — a sync node chains on the claim and never re-reads what another process confirmed.

import { describe, expect, test } from 'bun:test';
import { ensurePostsEntity, FakeWalsender, feedOver } from './pg-replication-fixture';
import { changeLsn } from './pg-replication-position';

const dialed = async (slotConfirmed: string | undefined, from: string) => {
  ensurePostsEntity();
  const server = new FakeWalsender(slotConfirmed === undefined ? {} : { slotConfirmed });
  const feed = feedOver(() => Promise.resolve(server), { fullIdentityTables: [] });
  const said: string[] = [];
  await feed.start({ from, onChange: () => undefined, onResume: (at) => said.push(at) });
  const start = server.queries.find((sql) => sql.startsWith('START_REPLICATION'));
  return { feed, said, start };
};

describe('dialReplication · the resume it claims', () => {
  test('a resume below the slot is claimed at the slot: another run confirmed past it', async () => {
    const { feed, said, start } = await dialed('0/9000', changeLsn(0x5000n, 2));
    expect(said).toEqual([changeLsn(0x9000n, 0)]);
    expect(feed.position()).toBe(changeLsn(0x9000n, 0));
    expect(start).toContain('LOGICAL 0/9000');
    await feed.stop();
  });

  test('a resume above the slot is claimed as given: the slot lags the last delivery', async () => {
    const { feed, said, start } = await dialed('0/3000', changeLsn(0x5000n, 2));
    expect(said).toEqual([changeLsn(0x5000n, 2)]);
    expect(feed.position()).toBe(changeLsn(0x5000n, 2));
    expect(start).toContain('LOGICAL 0/5000');
    await feed.stop();
  });

  test('a slot with no confirmed position leaves the resume as given', async () => {
    const { feed, said } = await dialed(undefined, changeLsn(0x5000n, 2));
    expect(said).toEqual([changeLsn(0x5000n, 2)]);
    await feed.stop();
  });
});
