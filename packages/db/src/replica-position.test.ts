// Read-your-writes across requests: a scope carrying an earlier write's position reads the replica
// only once the replica has replayed past it. Over two recording clients — the standby's replay
// position is a stub, so behind, caught up, garbage and unknown are each one line.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { recordingClient } from './fake';
import { replicatedClient } from './replica-client';
import { formatPosition, parsePosition } from './replica-position';
import { withReplicaReads } from './replica-scope';
import { sql } from './sql';

function fakeClock(): Clock & { advance(ms: number): void } {
  let ms = 0;
  return {
    now: () => new Date(ms),
    monotonic: () => ms,
    advance: (by) => {
      ms += by;
    },
  };
}

const REPLAY = /pg_last_wal_replay_lsn/;

function setup(replayed: string | null) {
  const primary = recordingClient();
  const replica = recordingClient().on(REPLAY, { rows: [{ lsn: replayed }] });
  const clock = fakeClock();
  const client = replicatedClient(primary, replica, { clock });
  const read = (minPosition: bigint | undefined) =>
    withReplicaReads(() => client.query(sql`select * from posts`), { minPosition });
  const sentTo = () => ({
    primary: primary.texts.filter((text) => text.startsWith('select * from posts')).length,
    replica: replica.texts.filter((text) => text.startsWith('select * from posts')).length,
  });
  return { primary, replica, clock, client, read, sentTo };
}

describe('parsePosition', () => {
  test('reads X/Y as one 64-bit number, and formats it back', () => {
    const position = parsePosition('16/B374D848');
    expect(position).toBe((0x16n << 32n) | 0xb374d848n);
    expect(formatPosition(position ?? 0n)).toBe('16/B374D848');
  });

  test('anything that is not a pg_lsn is undefined, never a guess', () => {
    for (const value of ['', 'abc', '1/', '/1', '1/2/3', '123456789/0', "0/0'; drop", null]) {
      expect(parsePosition(value)).toBeUndefined();
    }
  });
});

describe('a read carrying a position', () => {
  test('behind: the primary answers', async () => {
    const { read, sentTo } = setup('0/10');
    await read(parsePosition('0/20'));
    expect(sentTo()).toEqual({ primary: 1, replica: 0 });
  });

  test('caught up: the replica answers', async () => {
    const { read, sentTo } = setup('0/20');
    await read(parsePosition('0/20'));
    expect(sentTo()).toEqual({ primary: 0, replica: 1 });
  });

  test('a replica that cannot say (null replay position) is the primary`s', async () => {
    const { read, sentTo } = setup(null);
    await read(parsePosition('0/1'));
    expect(sentTo()).toEqual({ primary: 1, replica: 0 });
  });

  test('a garbage replay answer is unknown, and unknown is the primary', async () => {
    const { read, sentTo } = setup('not-an-lsn');
    await read(parsePosition('0/1'));
    expect(sentTo()).toEqual({ primary: 1, replica: 0 });
  });

  test('no position: the replica, and its replay position is never asked', async () => {
    const { read, sentTo, replica } = setup('0/0');
    await read(undefined);
    expect(sentTo()).toEqual({ primary: 0, replica: 1 });
    expect(replica.texts.some((text) => REPLAY.test(text))).toBe(false);
  });

  test('the replay position is cached per process for positionCacheMs', async () => {
    const { read, replica, clock } = setup('0/20');
    const asked = () => replica.texts.filter((text) => REPLAY.test(text)).length;
    await read(parsePosition('0/1'));
    await read(parsePosition('0/1'));
    expect(asked()).toBe(1);
    clock.advance(50);
    await read(parsePosition('0/1'));
    expect(asked()).toBe(2);
  });

  test('primaryPosition reads the primary, never the replica, even inside a scope', async () => {
    const { client, primary, replica } = setup('0/0');
    primary.on(/pg_current_wal_insert_lsn/, { rows: [{ lsn: '0/AB' }] });
    const position = await withReplicaReads(() => client.primaryPosition());
    expect(position).toBe(0xabn);
    expect(replica.texts.some((text) => text.includes('pg_current_wal_insert_lsn'))).toBe(false);
  });
});
