// `stop()` reads the walsender's goodbye before its own: CopyDone out, the server's CopyDone,
// CommandComplete and ReadyForQuery read, THEN Terminate. Closed over unread bytes the socket was
// reset, and Postgres logged `Connection reset by peer` on every replicator shutdown.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { PgReplicationStream } from './pg-replication';
import {
  complete,
  copyDone,
  ensurePostsEntity,
  FakeWalsender,
  joined,
  ready,
} from './pg-replication-fixture';
import { COPY_DRAIN_MS } from './pg-replication-goodbye';
import type { Scheduler } from './thundering-herd';

const COPY_DONE = 0x63;
const TERMINATE = 0x58;

/**
 * Answers a CopyDone as a walsender does — its own CopyDone at once, CommandComplete and
 * ReadyForQuery a round trip later (sent only once the client reads again) — and says whether that
 * last chunk had been read off the socket when `Terminate` arrived.
 */
class GoodbyeWalsender extends FakeWalsender {
  readonly #answers: boolean;
  #copyDone: Uint8Array | undefined;
  #tail: Uint8Array | undefined;
  goodbyeRead = false;
  /** `true`/`false` once `Terminate` arrives: whether the server's goodbye had been read by then. */
  terminatedAfterRead: boolean | undefined;

  constructor(answers: boolean) {
    super();
    this.#answers = answers;
  }

  override async read(): Promise<Uint8Array | undefined> {
    const tail = this.#tail;
    if (tail !== undefined && this.#copyDone === undefined) {
      this.#tail = undefined;
      this.push(tail);
    }
    const chunk = await super.read();
    if (chunk !== undefined && chunk === this.#copyDone) this.#copyDone = undefined;
    if (chunk !== undefined && chunk === tail) this.goodbyeRead = true;
    return chunk;
  }

  override write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] === TERMINATE) this.terminatedAfterRead = this.goodbyeRead;
    if (bytes[0] === COPY_DONE) {
      // Not the base's answer (all at once): CopyDone now, the rest a round trip later, or never.
      if (!this.#answers) return Promise.resolve();
      this.#copyDone = copyDone();
      this.#tail = joined(complete(), ready());
      this.push(this.#copyDone);
      return Promise.resolve();
    }
    return super.write(bytes);
  }
}

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 400; tick += 1) await Promise.resolve();
};

const streamOver = (server: FakeWalsender, schedule: Scheduler): PgReplicationStream => {
  ensurePostsEntity();
  return new PgReplicationStream(
    {
      url: 'postgres://replicator:secret@db.test:5432/app',
      slot: 'ultimate_slot',
      publication: 'ultimate_pub',
      entities: ['posts'],
      clock: frozenClock('2026-11-12T12:00:00.000Z'),
      stream: () => Promise.resolve(server),
      fullIdentityTables: [],
    },
    schedule,
  );
};

describe('stop() drains the walsender before Terminate', () => {
  test('Terminate is written only after ReadyForQuery was read', async () => {
    const server = new GoodbyeWalsender(true);
    const stream = streamOver(server, () => () => undefined);
    await stream.start({ onChange: () => undefined });
    await stream.stop();
    expect(server.terminatedAfterRead).toBe(true);
    expect(server.closed).toBe(true);
  });

  test(`a server that never answers is given up on at ${COPY_DRAIN_MS} ms, then closed`, async () => {
    const server = new GoodbyeWalsender(false);
    const timers: { fn: () => void; ms: number }[] = [];
    const stream = streamOver(server, (fn, ms) => {
      timers.push({ fn, ms });
      return () => undefined;
    });
    await stream.start({ onChange: () => undefined });
    let stopped = false;
    const stopping = stream.stop().then(() => {
      stopped = true;
    });
    await turns();
    expect(stopped).toBe(false);
    expect(server.terminatedAfterRead).toBeUndefined();
    expect(timers.map((one) => one.ms)).toEqual([COPY_DRAIN_MS]);
    for (const timer of timers) timer.fn();
    await stopping;
    expect(server.terminatedAfterRead).toBe(false);
    expect(server.closed).toBe(true);
  });
});
