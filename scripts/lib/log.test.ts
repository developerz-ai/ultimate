// The root scripts' stdout write: every byte, or — to a reader that never drains — one dropped,
// counted line and a script that still finishes. `EAGAIN` forever must not mean "never exits".

import { describe, expect, test } from 'bun:test';
import { droppedWrites, OUT_EAGAIN_ATTEMPTS, writeFully } from './log';

const eagain = (): never => {
  throw Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' });
};

describe('writeFully', () => {
  test('a pipe that answers EAGAIN forever still returns, after the bounded attempts', () => {
    let attempts = 0;
    const naps: number[] = [];
    const before = droppedWrites();
    const ok = writeFully(
      Buffer.from('never drains\n'),
      () => {
        attempts += 1;
        return eagain();
      },
      (ms) => naps.push(ms),
    );
    expect(ok).toBe(false);
    expect(attempts).toBe(OUT_EAGAIN_ATTEMPTS);
    expect(droppedWrites()).toBe(before + 1);
    expect(naps).toHaveLength(OUT_EAGAIN_ATTEMPTS - 1);
    expect(naps[1]).toBeGreaterThan(naps[0] ?? 0);
    expect(Math.max(...naps)).toBeLessThanOrEqual(32);
  });

  test('a transient EAGAIN is retried, every byte arrives, and progress resets the bound', () => {
    const out: number[] = [];
    let calls = 0;
    const before = droppedWrites();
    const ok = writeFully(
      Buffer.from('abc'),
      (_fd, data, offset) => {
        calls += 1;
        if (calls % OUT_EAGAIN_ATTEMPTS !== 0) return eagain();
        out.push(data[offset] ?? -1);
        return 1;
      },
      () => {},
    );
    expect(ok).toBe(true);
    expect(Buffer.from(out).toString()).toBe('abc');
    expect(droppedWrites()).toBe(before);
  });

  test('any other error is rethrown on the first attempt', () => {
    let calls = 0;
    const epipe = (): never => {
      calls += 1;
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    expect(() => writeFully(Buffer.from('x'), epipe, () => {})).toThrow('EPIPE');
    expect(calls).toBe(1);
  });

  test('a write that makes no progress is a stall, so it cannot spin', () => {
    expect(
      writeFully(
        Buffer.from('x'),
        () => 0,
        () => {},
      ),
    ).toBe(false);
  });
});
