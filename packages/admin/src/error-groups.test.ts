// Error groups in one process: the memory store held to the shared contract, and the sink — one
// group per fingerprint, `onNewGroup` once per group, the per-minute cap counting instead of
// writing, redaction on the sample, and a store that fails never reaching the reporter again.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import {
  errorReport,
  frozenClock,
  REDACTED,
  reportError,
  resetErrorReporting,
  UltimateError,
} from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { STORE_CASES } from './error-groups-fixture';
import { type ErrorGroupNotice, errorGroupsSink } from './error-groups-sink';
import {
  type ErrorGroupsStore,
  errorGroupsPurgeTarget,
  memoryErrorGroupsStore,
} from './error-groups-store';

afterEach(() => resetErrorReporting());

describe('memoryErrorGroupsStore — the shared contract', () => {
  for (const { name, run } of STORE_CASES) {
    test(name, () => run(memoryErrorGroupsStore(), 'm-'));
  }
});

const fault = (operation: string, meta: Record<string, unknown> = {}): ErrorReport =>
  errorReport(
    new UltimateError({
      code: 'X_ORDER_STUCK',
      cause: `order ${String(meta['orderId'] ?? 'o_1')} is stuck\nsecond line`,
      fix: 'x jobs show orders --json',
      meta,
    }),
    { source: 'http', scope: { operation } },
  );

const enqueued: ErrorGroupNotice[] = [];
const onNewGroup = {
  name: 'app.openIssue',
  enqueue: async (input: ErrorGroupNotice) => {
    enqueued.push(input);
    return { id: `job-${enqueued.length}`, runId: `run-${enqueued.length}`, deduped: false };
  },
};

afterEach(() => {
  enqueued.length = 0;
});

describe('errorGroupsSink', () => {
  test('one fault across two requests is one group of two, and one onNewGroup', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store, onNewGroup });
    installErrorReporter(sink);
    reportError(fault('POST /orders', { orderId: 'o_1' }).error, {
      source: 'http',
      scope: { operation: 'POST /orders' },
    });
    reportError(fault('POST /orders', { orderId: 'o_2' }).error, {
      source: 'http',
      scope: { operation: 'POST /orders' },
    });
    await sink.settled();
    const groups = await store.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    // The latest occurrence's cause names the group in the list.
    expect(groups[0]?.message).toStartWith('order o_2 is stuck');
    expect(enqueued.map((notice) => notice.fingerprint)).toEqual([groups[0]?.fingerprint ?? '']);
    expect(enqueued[0]?.code).toBe('X_ORDER_STUCK');
  });

  test('two operations are two groups', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store, onNewGroup });
    sink.report(fault('POST /orders'));
    sink.report(fault('POST /refunds'));
    await sink.settled();
    expect(await store.list()).toHaveLength(2);
    expect(enqueued).toHaveLength(2);
  });

  test('a credential in meta is redacted on the sample', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store });
    sink.report(fault('POST /orders', { orderId: 'o_9', apiToken: 'sk_live_1' }));
    await sink.settled();
    const [group] = await store.list();
    expect(group?.sample.meta).toEqual({ orderId: 'o_9', apiToken: REDACTED });
  });

  test('the message is the head of the cause, never a page of text', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store });
    sink.report(fault('POST /orders', { orderId: 'o'.repeat(500) }));
    await sink.settled();
    expect((await store.list())[0]?.message).toHaveLength(200);
  });

  test('ignore drops a report before it is grouped', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store, ignore: (report) => report.code === 'X_ORDER_STUCK' });
    sink.report(fault('POST /orders'));
    await sink.settled();
    expect(await store.list()).toEqual([]);
  });

  test('over the per-minute cap a report is counted, and written once the minute turns', async () => {
    const store = memoryErrorGroupsStore();
    const clock = frozenClock('2026-11-06T10:00:00.000Z');
    const sink = errorGroupsSink({ store, perMinute: 2, clock });
    for (let index = 0; index < 5; index += 1) sink.report(fault('POST /orders'));
    await sink.settled();
    expect((await store.list())[0]?.count).toBe(2);
    clock.advance(60_000);
    sink.report(fault('POST /orders'));
    await sink.settled();
    expect((await store.list())[0]?.count).toBe(6);
  });

  test('a store that fails logs and never re-enters the reporter', async () => {
    const failing: ErrorGroupsStore = {
      ...memoryErrorGroupsStore(),
      record: () => Promise.reject(new Error('database is down')),
    };
    const sink = errorGroupsSink({ store: failing });
    let reports = 0;
    installErrorReporter({
      report: (event) => {
        reports += 1;
        sink.report(event);
      },
    });
    reportError(fault('POST /orders').error, { source: 'http' });
    await sink.settled();
    expect(reports).toBe(1);
  });

  test('a cap that is not a count is refused at declaration', () => {
    expect(() =>
      errorGroupsSink({ store: memoryErrorGroupsStore(), perMinute: Number.NaN }),
    ).toThrow('perMinute');
  });
});

describe('errorGroupsPurgeTarget', () => {
  test('sweeps against the job clock, and needs a finite retention', async () => {
    const store = memoryErrorGroupsStore();
    const sink = errorGroupsSink({ store });
    sink.report(fault('POST /orders'));
    await sink.settled();
    const [group] = await store.list();
    const seen = Date.parse(group?.lastSeen ?? '');
    const target = errorGroupsPurgeTarget(store, { olderThanMs: 1_000 });
    expect(target.name).toBe('x_error_groups');
    expect(await target.purgeExpired(seen + 500)).toBe(0);
    expect(await target.purgeExpired(seen + 1_500)).toBe(1);
    expect(() => errorGroupsPurgeTarget(store, { olderThanMs: Number.NaN })).toThrow();
  });
});
