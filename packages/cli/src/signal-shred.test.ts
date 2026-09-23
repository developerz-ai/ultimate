import { describe, expect, test } from 'bun:test';
import { shredOnSignal } from './signal-shred';

// Row s: the listener that shredded the buffer also swallowed the signal.
describe('unit · a signal shreds the buffer AND still terminates', () => {
  test('SIGINT shreds, then re-raises the same signal, and the listener is gone', () => {
    const calls: string[] = [];
    const before = process.listenerCount('SIGINT');
    shredOnSignal(
      () => calls.push('shred'),
      (signal) => calls.push(`reraise ${signal}`),
    );
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.emit('SIGINT', 'SIGINT');
    expect(calls).toEqual(['shred', 'reraise SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before);
    process.emit('SIGTERM', 'SIGTERM');
  });

  test('the undo removes both listeners on the normal path', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const undo = shredOnSignal(
      () => undefined,
      () => undefined,
    );
    undo();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});
