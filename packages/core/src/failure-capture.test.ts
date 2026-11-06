// The failure buffer: nothing when off, a held bundle on a 5xx, nothing on a 4xx, the bounds, and a
// store that refuses never changing what the caller gets.

import { afterEach, expect, test } from 'bun:test';
import { userActor } from './actor';
import { ctxOf, runWithContext } from './context';
import { reportError } from './error-reporter';
import { UltimateError } from './errors';
import type { FailureBundle, FailureStore } from './failure-capture';
import {
  failureCaptureActive,
  recordFailureFact,
  recordFailureInput,
  setFailureStore,
  withFailureCapture,
} from './failure-capture';
import { resetFailureCaptureWindows, settleFailureCaptures } from './failure-capture-flush';
import { REDACTED } from './secret';

const statusOf = (code: string): number => (code === 'X_NOPE' ? 404 : 500);
const memoryStore = (): FailureStore & { readonly saved: FailureBundle[] } => {
  const saved: FailureBundle[] = [];
  return { saved, save: async (bundle) => void saved.push(bundle) };
};

afterEach(() => {
  setFailureStore(null, { perHour: 5, maxRows: 50, maxBytes: 64 * 1024 });
  resetFailureCaptureWindows();
});

const failing = (code: string) => async () => {
  recordFailureInput({ title: 'x', password: 'hunter2' });
  recordFailureFact({ kind: 'read', entity: 'posts', row: { id: 'p1', apiKey: 'k' } });
  recordFailureFact({ kind: 'flag', key: 'beta', value: true });
  throw new UltimateError({ code, cause: 'planted', fix: 'x verify' });
};

const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the planted failure did not throw');
};

test('off: no buffer is opened, so a seam below records nothing and allocates nothing', async () => {
  let active = true;
  await withFailureCapture('action', 'createPost', statusOf, async () => {
    active = failureCaptureActive();
  });
  expect(active).toBe(false);
});

test('a 5xx holds the bundle on the thrown value and reportError stores it, masked', async () => {
  const store = memoryStore();
  setFailureStore(store);
  const ctx = ctxOf({ actor: userActor({ id: 'm1', orgId: 'o1', roles: ['owner'] }) });
  const error = await runWithContext(ctx, () =>
    caught(() => withFailureCapture('action', 'createPost', statusOf, failing('X_BOOM'))),
  );
  reportError(error, { source: 'http', scope: { operation: 'POST /api/create-post' } });
  await settleFailureCaptures();
  const [bundle] = store.saved;
  expect(bundle?.code).toBe('X_BOOM');
  expect(bundle?.name).toBe('createPost');
  expect(bundle?.operation).toBe('POST /api/create-post');
  expect(bundle?.input).toEqual({ title: 'x', password: REDACTED });
  expect(bundle?.masked).toEqual(['password']);
  expect(bundle?.reads).toEqual([
    { entity: 'posts', row: { id: 'p1', apiKey: REDACTED }, masked: ['apiKey'] },
  ]);
  expect(bundle?.flags).toEqual({ beta: true });
  expect(bundle?.actor?.roles).toEqual(['owner']);
  expect(bundle?.requestId).toBe(ctx.requestId);
  expect(JSON.stringify(store.saved)).not.toContain('hunter2');
});

test('a 4xx holds nothing', async () => {
  const store = memoryStore();
  setFailureStore(store);
  const error = await caught(() =>
    withFailureCapture('action', 'createPost', statusOf, failing('X_NOPE')),
  );
  reportError(error, { source: 'http' });
  await settleFailureCaptures();
  expect(store.saved).toEqual([]);
});

test('per fingerprint per hour, then rows past maxRows are dropped and the bundle says so', async () => {
  const store = memoryStore();
  setFailureStore(store, { perHour: 2, maxRows: 0 + 1 });
  for (let i = 0; i < 3; i += 1) {
    const error = await caught(() =>
      withFailureCapture('action', 'a', statusOf, async () => {
        recordFailureFact({ kind: 'read', entity: 'posts', row: { id: '1' } });
        recordFailureFact({ kind: 'read', entity: 'posts', row: { id: '2' } });
        throw new UltimateError({ code: 'X_BOOM', cause: 'planted', fix: 'x verify' });
      }),
    );
    reportError(error, { source: 'http' });
  }
  await settleFailureCaptures();
  expect(store.saved).toHaveLength(2);
  expect(store.saved[0]?.reads).toHaveLength(1);
  expect(store.saved[0]?.truncated).toBe(true);
});

test('a bundle over maxBytes loses rows, not the input', async () => {
  const store = memoryStore();
  setFailureStore(store, { maxBytes: 1200 });
  const error = await caught(() =>
    withFailureCapture('action', 'a', statusOf, async () => {
      recordFailureInput({ title: 'kept' });
      for (let i = 0; i < 20; i += 1) {
        recordFailureFact({
          kind: 'read',
          entity: 'posts',
          row: { id: `${i}`, body: 'x'.repeat(80) },
        });
      }
      throw new UltimateError({ code: 'X_BOOM', cause: 'planted', fix: 'x verify' });
    }),
  );
  reportError(error, { source: 'http' });
  await settleFailureCaptures();
  const [bundle] = store.saved;
  expect(bundle?.input).toEqual({ title: 'kept' });
  expect(bundle?.truncated).toBe(true);
  expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(1200);
});

test('a store that refuses leaves the failure exactly as it was thrown', async () => {
  setFailureStore({ save: () => Promise.reject(new Error('database away')) });
  const error = await caught(() =>
    withFailureCapture('query', 'feed', statusOf, failing('X_BOOM')),
  );
  expect(() => reportError(error, { source: 'http' })).not.toThrow();
  await settleFailureCaptures();
  expect((error as UltimateError).code).toBe('X_BOOM');
});

test('a call inside a call keeps the outer one: one buffer, the outer input', async () => {
  const store = memoryStore();
  setFailureStore(store);
  const error = await caught(() =>
    withFailureCapture('action', 'outer', statusOf, async () => {
      recordFailureInput({ from: 'outer' });
      await withFailureCapture('action', 'inner', statusOf, failing('X_BOOM'));
    }),
  );
  reportError(error, { source: 'http' });
  await settleFailureCaptures();
  expect(store.saved.map((bundle) => [bundle.name, bundle.input])).toEqual([
    ['outer', { from: 'outer' }],
  ]);
});
