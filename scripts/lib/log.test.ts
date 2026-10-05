// The root scripts' stdout write: every byte, or — to a reader that never drains — one dropped,
// counted line and a script that still finishes. `EAGAIN` forever must not mean "never exits".

import { beforeEach, describe, expect, test } from 'bun:test';
import { droppedWrites, OUT_EAGAIN_ATTEMPTS, writeFully } from './log';

const eagain = (): never => {
  throw Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' });
};

/** A reader that drains: takes every byte handed to it, and records them. */
const sink =
  (into: number[] = []) =>
  (_fd: number, data: Uint8Array, offset: number, length: number): number => {
    into.push(...data.subarray(offset, offset + length));
    return length;
  };

describe('writeFully', () => {
  // Degraded/torn state is process-wide, as the pipe is; a drained write is what clears it.
  beforeEach(() => {
    writeFully(Buffer.from('x\n'), sink(), () => {});
  });

  test('after a drop, a reader that still never drains costs ONE attempt and no sleep', () => {
    writeFully(Buffer.from('first\n'), eagain, () => {});
    let attempts = 0;
    const naps: number[] = [];
    const before = droppedWrites();
    const ok = writeFully(
      Buffer.from('second\n'),
      () => {
        attempts += 1;
        return eagain();
      },
      (ms) => naps.push(ms),
    );
    expect(ok).toBe(false);
    expect(attempts).toBe(1);
    expect(naps).toEqual([]);
    expect(droppedWrites()).toBe(before + 1);
  });

  test('a write that arrives clears degraded mode: the next stall gets the full budget', () => {
    writeFully(Buffer.from('first\n'), eagain, () => {});
    expect(writeFully(Buffer.from('drained\n'), sink(), () => {})).toBe(true);
    let attempts = 0;
    writeFully(
      Buffer.from('third\n'),
      () => {
        attempts += 1;
        return eagain();
      },
      () => {},
    );
    expect(attempts).toBe(OUT_EAGAIN_ATTEMPTS);
  });

  test('text dropped half-written is terminated before the next, never glued to it', () => {
    let calls = 0;
    const out: number[] = [];
    writeFully(
      Buffer.from('abcdef\n'),
      (_fd, data, offset) => {
        calls += 1;
        if (calls > 3) return eagain();
        out.push(data[offset] ?? -1);
        return 1;
      },
      () => {},
    );
    expect(writeFully(Buffer.from('next\n'), sink(out), () => {})).toBe(true);
    expect(Buffer.from(out).toString()).toBe('abc\nnext\n');
    const after: number[] = [];
    writeFully(Buffer.from('later\n'), sink(after), () => {});
    expect(Buffer.from(after).toString()).toBe('later\n');
  });

  test('text dropped with nothing written leaves no stray newline behind', () => {
    writeFully(Buffer.from('lost\n'), eagain, () => {});
    const out: number[] = [];
    writeFully(Buffer.from('next\n'), sink(out), () => {});
    expect(Buffer.from(out).toString()).toBe('next\n');
  });

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
