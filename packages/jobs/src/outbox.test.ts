import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { OutboxNoTxError } from './errors';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import type { OutboxStore } from './outbox';
import {
  createJobsFacade,
  createMemoryOutboxStore,
  createOutboxRelay,
  enqueueInTx,
  resetJobsFacade,
  setJobsFacade,
} from './outbox';

/** Minimal Standard Schema so these tests do not depend on the shipped provider's surface. */
function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface OrgInput {
  readonly orgId: string;
}

let notify: JobHandle<OrgInput>;

beforeEach(() => {
  resetJobs();
  notify = job<OrgInput>({
    name: 'notifySubscribers',
    input: passthrough<OrgInput>(),
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 3, backoff: 'exponential' },
    run: () => Promise.resolve(),
  });
});

// The facade slot is process-global, like the driver: a leaked one would silently reroute
// every later enqueue in this bun process into this file's transaction.
afterEach(() => {
  resetJobsFacade();
});

const fakeTx = (): Tx => ({ id: 'tx-1' }) as unknown as Tx;

describe('transactional outbox', () => {
  test('a job staged in a rolled-back transaction is never delivered', async () => {
    const driver = createMemoryDriver();
    const store: OutboxStore = createMemoryOutboxStore();
    const relay = createOutboxRelay({ store, driver });
    const tx = fakeTx();

    await enqueueInTx({ store, driver }, tx, notify, { orgId: 'org-1' });
    // The relay must not see staged rows before commit either.
    expect(await relay.tick()).toBe(0);

    await store.rollback(tx);
    expect(await relay.tick()).toBe(0);

    const listed = await driver.introspect?.list();
    expect(listed).toEqual([]);
  });

  test('a job staged in a committed transaction is delivered exactly once by the relay', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const relay = createOutboxRelay({ store, driver });
    const tx = fakeTx();

    await enqueueInTx({ store, driver }, tx, notify, { orgId: 'org-1' });
    await store.commit(tx);

    expect(await relay.tick()).toBe(1);
    // Second pass: nothing left to publish, and no duplicate row.
    expect(await relay.tick()).toBe(0);
    expect(await relay.pending()).toBe(0);

    const listed = (await driver.introspect?.list()) ?? [];
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe('notifySubscribers');
    expect(listed[0]?.idempotencyKey).toBe('notify:org-1');
  });

  test('a re-published outbox row is collapsed by the idempotency key (at-least-once)', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const tx = fakeTx();

    await enqueueInTx({ store, driver }, tx, notify, { orgId: 'org-1' });
    const [record] = await store.commit(tx);
    if (record === undefined) throw new Error('expected one staged record');

    // Simulate a relay crash between publish and markPublished: publish twice.
    const first = await driver.enqueue({
      name: record.job,
      queue: record.queue,
      input: record.input,
      idempotencyKey: record.idempotencyKey,
      maxAttempts: record.maxAttempts,
    });
    const second = await driver.enqueue({
      name: record.job,
      queue: record.queue,
      input: record.input,
      idempotencyKey: record.idempotencyKey,
      maxAttempts: record.maxAttempts,
    });

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });
});

describe('ctx.jobs.enqueue facade', () => {
  test('joins the ambient transaction when there is one, publishes directly when there is not', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const tx = fakeTx();
    let ambient: Tx | undefined = tx;
    const jobs = createJobsFacade({ store, driver }, () => ambient);

    await jobs.enqueue(notify, { orgId: 'org-1' });
    expect(((await driver.introspect?.list()) ?? []).length).toBe(0);
    expect(await store.pendingCount()).toBe(0);
    await store.commit(tx);
    expect(await store.pendingCount()).toBe(1);

    ambient = undefined;
    await jobs.enqueue(notify, { orgId: 'org-2' });
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });

  test('outbox mode "required" refuses an enqueue with no transaction', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const jobs = createJobsFacade({ store, driver, mode: 'required' }, () => undefined);
    await expect(jobs.enqueue(notify, { orgId: 'org-3' })).rejects.toThrow(OutboxNoTxError);
  });
});

describe('handle.enqueue through the installed facade', () => {
  test('stages into the ambient transaction — the row exists only after commit', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const relay = createOutboxRelay({ store, driver });
    const tx = fakeTx();
    let ambient: Tx | undefined = tx;
    setJobsFacade(createJobsFacade({ store, driver }, () => ambient));

    const staged = await notify.enqueue({ orgId: 'org-1' });
    // No queue id yet: the row does not exist until COMMIT, and neither does the relay's work.
    expect(staged.runId).toBe('');
    expect(await relay.tick()).toBe(0);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(0);

    await store.commit(tx);
    expect(await relay.tick()).toBe(1);

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0]?.idempotencyKey).toBe('notify:org-1');

    // Same call site, no transaction in scope: published directly, no outbox hop.
    ambient = undefined;
    await notify.enqueue({ orgId: 'org-2' });
    expect(((await driver.introspect?.list()) ?? []).length).toBe(2);
  });

  test('the installed facade carries handle.as tenant stamping into the outbox row', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const tx = fakeTx();
    setJobsFacade(createJobsFacade({ store, driver }, () => tx));

    await notify.as({ orgId: 'org-9' }, { orgId: 'org-9' });
    const [record] = await store.commit(tx);
    expect(record?.tenantId).toBe('org-9');
  });

  test('resetJobsFacade puts the process back to the driver-only fallback', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const tx = fakeTx();
    setJobsFacade(createJobsFacade({ store, driver }, () => tx));
    resetJobsFacade();

    // No driver installed either, so the fallback has nothing to publish to and says so.
    await expect(notify.enqueue({ orgId: 'org-4' })).rejects.toThrow('X_DRIVER_UNAVAILABLE');
    expect(await store.pendingCount()).toBe(0);
  });
});

describe('the relay loop', () => {
  /** A store whose `claim` fails N times, then behaves. Models a pool timeout in a failover. */
  function flakyStore(failures: number): OutboxStore & { claims: number } {
    const inner = createMemoryOutboxStore();
    let left = failures;
    return {
      claims: 0,
      stage: (tx, record) => inner.stage(tx, record),
      commit: (tx) => inner.commit(tx),
      rollback: (tx) => inner.rollback(tx),
      claim(limit) {
        this.claims += 1;
        if (left > 0) {
          left -= 1;
          return Promise.reject(new Error('connection pool timeout'));
        }
        return inner.claim(limit);
      },
      markPublished: (id, at) => inner.markPublished(id, at),
      pendingCount: () => inner.pendingCount(),
    };
  }

  // `void tick().finally(...)` with no `.catch` makes a rejected `claim()` an unhandled
  // rejection, and Bun's default for one is to end the process — with the staged rows still
  // unpublished. Bun's test runner fails this file on an unhandled rejection, which is what
  // makes this a test rather than a claim.
  test('survives a claim that rejects and publishes on the next pass', async () => {
    const driver = createMemoryDriver();
    const store = flakyStore(1);
    const tx = fakeTx();
    setJobsFacade(createJobsFacade({ store, driver }, () => tx));
    await notify.enqueue({ orgId: 'org-relay' });
    await store.commit(tx);

    const relay = createOutboxRelay({ store, driver, intervalMs: 5 });
    relay.start();
    try {
      const deadline = Date.now() + 2_000;
      while (store.claims < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      relay.stop();
    }

    expect(store.claims).toBeGreaterThanOrEqual(2);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
    expect(await store.pendingCount()).toBe(0);
  });
});

describe('createMemoryOutboxStore retention', () => {
  // Rewriting the record in place kept every payload ever enqueued for the process's lifetime,
  // and made `claim()` and `pendingCount()` walk all of them every 200ms tick.
  test('holds nothing once a row is published', async () => {
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const relay = createOutboxRelay({ store, driver, batchSize: 500 });

    for (let i = 0; i < 200; i += 1) {
      const tx = fakeTx();
      await enqueueInTx({ store, driver }, tx, notify, { orgId: `org-${i}` });
      await store.commit(tx);
    }
    expect(store.retained()).toBe(200);

    expect(await relay.tick()).toBe(200);
    expect(store.retained()).toBe(0);
    expect(await store.pendingCount()).toBe(0);
  });
});
