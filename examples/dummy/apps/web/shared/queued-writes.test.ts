/**
 * unit — "this will be sent when you reconnect" shows for a write the OUTBOX holds, and only then.
 *
 * The notice used to read `connection.offline && like.pending > 0`, and neither half is the fact:
 * `pending` counts writes in flight and drops to zero the moment a failed one is handed to the
 * outbox, and an open socket survives the browser going offline. What `useMutation` does say is
 * the answer — it resolves `undefined` exactly when the write was queued (`use-mutation.ts`).
 */

import { expect, test } from '@ultimat3/testing';
import { createRoot } from 'solid-js';
import { trackQueued } from './queued-writes';

const inRoot = <T>(fn: () => T): { value: T; dispose: () => void } => {
  let dispose = (): void => undefined;
  const value = createRoot((d) => {
    dispose = d;
    return fn();
  });
  return { value, dispose };
};

test('a write the server answered is not queued; one the outbox took is', async () => {
  const { value: queued, dispose } = inRoot(trackQueued);
  await queued.track(Promise.resolve({ id: 'p1' }));
  expect(queued.count()).toBe(0);
  await queued.track(Promise.resolve(undefined));
  expect(queued.count()).toBe(1);
  dispose();
});

test('a refused write is not queued, and the refusal is not left unhandled', async () => {
  const { value: queued, dispose } = inRoot(trackQueued);
  await queued.track(Promise.reject(new TypeError('refused')));
  expect(queued.count()).toBe(0);
  dispose();
});

test("the browser's `online` — the outbox's own replay trigger — clears the notice", async () => {
  const { value: queued, dispose } = inRoot(trackQueued);
  await queued.track(Promise.resolve(undefined));
  globalThis.dispatchEvent(new Event('online'));
  expect(queued.count()).toBe(0);
  dispose();
});
