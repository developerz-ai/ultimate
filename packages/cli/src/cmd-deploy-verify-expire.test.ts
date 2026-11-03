// The production expiry a hung queue read races: disarmed, it clears its timer, so nothing it armed
// holds the CLI open past the verdict. The command's own tests hand in a mock and never reach this.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { expireAfter } from './cmd-deploy-verify';

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Every timer `expireAfter` arms, and every one it clears, without moving real time. */
function watchTimers(): { readonly armed: unknown[]; readonly cleared: unknown[] } {
  const armed: unknown[] = [];
  const cleared: unknown[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: [() => void, number]
  ) => {
    const timer = realSet(...args);
    armed.push(timer);
    return timer;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: unknown) => {
    cleared.push(timer);
    realClear(timer as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout);
  spies.push(set, clear);
  return { armed, cleared };
}

describe('expireAfter', () => {
  test('a disarm clears the one timer it armed', () => {
    const timers = watchTimers();
    const disarm = new AbortController();
    void expireAfter(60_000, disarm.signal);
    expect(timers.armed.length).toBe(1);
    expect(timers.cleared).toEqual([]);
    disarm.abort();
    expect(timers.cleared).toEqual(timers.armed);
  });

  test('left armed, it resolves once the time passes', async () => {
    const disarm = new AbortController();
    await expect(expireAfter(0, disarm.signal)).resolves.toBeUndefined();
  });
});
