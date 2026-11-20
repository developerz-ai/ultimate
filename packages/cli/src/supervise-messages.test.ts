// The IPC vocabulary: every message both sides send is strings, numbers and booleans only (json
// serialization drops or throws on anything richer), and the readers refuse what is not ours.

import { describe, expect, test } from 'bun:test';
import type { ChildMessage, DrainMessage } from './supervise-messages';
import { drainMessage, readChildMessage, readDrainMessage } from './supervise-messages';

const FROM_CHILD: readonly ChildMessage[] = [
  { type: 'x-proc', event: 'ready', metricsUrl: 'http://127.0.0.1:41000', budgetMs: 30_000 },
  { type: 'x-proc', event: 'draining', budgetMs: 30_000 },
  { type: 'x-proc', event: 'gone', code: 0 },
  { type: 'x-proc', event: 'fatal', code: 'X_PROCESSES_UNSHARED_STATE' },
];

const SENT: readonly (ChildMessage | DrainMessage)[] = [...FROM_CHILD, drainMessage('SIGTERM')];

describe('unit · supervise messages', () => {
  test('every value is a string, a number or a boolean, and survives a JSON round trip', () => {
    for (const message of SENT) {
      for (const value of Object.values(message)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
      expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    }
  });

  test('each child message reads back as itself', () => {
    for (const message of FROM_CHILD) expect(readChildMessage(message)).toEqual(message);
  });

  test.each([
    null,
    'ready',
    { event: 'ready', metricsUrl: 'x', budgetMs: 1 },
    { type: 'x-proc', event: 'ready', metricsUrl: 1, budgetMs: 1 },
    { type: 'x-proc', event: 'draining', budgetMs: -1 },
    { type: 'x-proc', event: 'gone', code: '0' },
    { type: 'x-proc', event: 'bogus' },
  ])('%p is not a child message', (message) => {
    expect(readChildMessage(message)).toBeUndefined();
  });

  test('a drain names one of the three forwarded signals', () => {
    expect(readDrainMessage(drainMessage('SIGUSR2'))).toEqual(drainMessage('SIGUSR2'));
    expect(readDrainMessage({ type: 'x-proc', event: 'drain', signal: 'SIGKILL' })).toBeUndefined();
    expect(readDrainMessage({ type: 'x-dev-drain', signal: 'SIGTERM' })).toBeUndefined();
  });
});
