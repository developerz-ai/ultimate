// A deploy is a NEW replicator process: the old one stops cleanly and hands over how far its slot
// was confirmed; the new one says it resumed there. A sync node that read both re-snapshots nobody.
// A crash (no handover), a lost tail, and every half-upgraded pairing still read as a gap.

import { describe, expect, test } from 'bun:test';
import { memoryAdvisoryLock } from './advisory-lock';
import { formatLsn } from './changefeed';
import { InProcessTransport } from './fanout';
import { printLsn } from './pg-bytes';
import {
  begin,
  commit,
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  insert,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  xlog,
} from './pg-replication-fixture';
import { parseResync } from './replication-resync';
import { CHANGE_SUBJECT_PREFIX, changeFeedReplicator } from './replicator';
import { parseEnvelope, SeqGapDetector } from './replicator-envelope';
import { encodeHandover, HANDOVER_SUBJECT, parseHandover } from './replicator-handover';

const change = (position: number, producer: string, seq: number, from?: number) => ({
  change: {
    table: 'posts',
    op: 'insert' as const,
    before: null,
    after: { id: `p${position}` },
    lsn: formatLsn(position),
    txid: String(position),
    orgId: null,
    at: 0,
    write: null,
  },
  seq,
  producer,
  ...(from === undefined ? {} : { from: formatLsn(from) }),
});

describe('the handover on the wire', () => {
  test('round-trips, and a node that predates it drops it as it drops any unknown payload', () => {
    const payload = encodeHandover({ producer: 'r1', seq: 3, through: formatLsn(9) });
    expect(parseHandover(payload)).toEqual({ producer: 'r1', seq: 3, through: formatLsn(9) });
    // An old node: no `table`, no `lsn` — not a change; not a resync either.
    expect(parseEnvelope(payload)).toBeNull();
    expect(parseResync(payload)).toBeNull();
    expect(HANDOVER_SUBJECT.startsWith(`${CHANGE_SUBJECT_PREFIX}.`)).toBe(true);
  });

  test('another version is not read: the node falls back to "gap"', () => {
    const payload = encodeHandover({ producer: 'r1', seq: 3, through: formatLsn(9) });
    expect(parseHandover(payload.replace('"handover":2', '"handover":3'))).toBeNull();
    expect(parseHandover('{"handover":2,"producer":"r1","seq":0,"through":"x"}')).toBeNull();
  });
});

describe('SeqGapDetector.handOver', () => {
  test('a clean goodbye, then a run that resumed where it ended: no gap', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(change(1, 'r1', 1));
    gaps.observe(change(2, 'r1', 2));
    // r1's slot was confirmed past its last change (a keepalive): position 5.
    expect(gaps.handOver({ producer: 'r1', seq: 3, through: formatLsn(5) })).toBe(false);
    expect(gaps.observe(change(6, 'r2', 1, 5))).toBe(false);
  });

  test('without the goodbye the same run is a gap — a crash', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(change(1, 'r1', 1));
    gaps.observe(change(2, 'r1', 2));
    expect(gaps.observe(change(6, 'r2', 1, 5))).toBe(true);
  });

  test('a goodbye after a tail this node never got is a gap', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(change(1, 'r1', 1));
    expect(gaps.handOver({ producer: 'r1', seq: 3, through: formatLsn(5) })).toBe(true);
  });

  test('a run that published nothing chains through its goodbye when its start did', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(change(1, 'r1', 1));
    gaps.handOver({ producer: 'r1', seq: 2, through: formatLsn(4) });
    const quiet = { producer: 'r2', seq: 1, through: formatLsn(8), from: formatLsn(4) };
    expect(gaps.handOver(quiet)).toBe(false);
    expect(gaps.observe(change(9, 'r3', 1, 8))).toBe(false);
    // One that cannot say where it started is a gap.
    expect(gaps.handOver({ producer: 'r4', seq: 1, through: formatLsn(10) })).toBe(true);
  });
});

/** A walsender whose slot was confirmed at `confirmed`, as a predecessor's clean stop left it. */
const process = (
  confirmed: bigint | null,
  transport: InProcessTransport,
  servers: FakeWalsender[],
) => {
  ensurePostsEntity();
  const script = confirmed === null ? {} : { slotConfirmed: printLsn(confirmed) };
  const feed = feedOver(() => {
    const server = new FakeWalsender(script);
    servers.push(server);
    return Promise.resolve(server);
  });
  // One lock per process: a crashed holder's session is gone, so its grant is too.
  const lock = memoryAdvisoryLock(`x:replicator:handover-${crypto.randomUUID()}`);
  // No restart timer ever fires: a dead run stays dead, as a killed process does.
  return changeFeedReplicator({ feed, transport, lock, schedule: () => () => undefined });
};

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 400; tick += 1) await Promise.resolve();
};

/** One transaction of one row, committing at `at`. */
const row = (server: FakeWalsender | undefined, at: bigint, id: string, xid: number): void => {
  server?.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  server?.push(xlog(begin(at, 0n, xid)));
  server?.push(xlog(insert(POSTS_OID, [id, 't', 'org-1', null, null, null])));
  server?.push(xlog(commit(at, at + 0x10n, 0n)));
};

describe('a replicator deploy: two processes over one slot', () => {
  const rig = async () => {
    const transport = new InProcessTransport();
    const gaps = new SeqGapDetector();
    let invalidations = 0;
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      const handover = parseHandover(payload);
      const envelope = handover === null ? parseEnvelope(payload) : null;
      const gap = handover !== null ? gaps.handOver(handover) : envelope && gaps.observe(envelope);
      if (gap) invalidations += 1;
    });
    return { transport, invalidations: () => invalidations };
  };

  test('a clean stop, then a new process: zero invalidations', async () => {
    const { transport, invalidations } = await rig();
    const servers: FakeWalsender[] = [];
    const old = process(null, transport, servers);
    await old.start();
    row(servers[0], 0x1000n, 'p1', 1);
    await turns();
    await old.stop();
    // The new process finds the slot where the old one's last confirm left it.
    const confirmed = servers[0]?.standby.at(-1)?.position ?? 0n;
    expect(confirmed).toBe(0x1010n);
    const next = process(confirmed, transport, servers);
    await next.start();
    row(servers[1], 0x2000n, 'p2', 2);
    await turns();
    await next.stop();
    expect(next.stats().published).toBe(1);
    expect(invalidations()).toBe(0);
  });

  test('a crash (no goodbye), then a new process: exactly one invalidation', async () => {
    const { transport, invalidations } = await rig();
    const servers: FakeWalsender[] = [];
    const old = process(null, transport, servers);
    await old.start();
    row(servers[0], 0x1000n, 'p1', 1);
    await turns();
    // The process dies: the slot keeps a confirm past what this node read, and nothing is said.
    servers[0]?.close();
    const next = process(0x1010n, transport, servers);
    await next.start();
    row(servers[1], 0x2000n, 'p2', 2);
    row(servers[1], 0x3000n, 'p3', 3);
    await turns();
    await next.stop();
    await old.stop();
    expect(invalidations()).toBe(1);
  });
});
