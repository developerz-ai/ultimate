import { describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { err, isErr, isOk, map, mapErr, ok, tryCatch, unwrap, unwrapOr } from './result';

describe('Result', () => {
  test('maps the ok branch and leaves the err branch untouched', () => {
    expect(map(ok(2), (value) => value * 3)).toEqual({ ok: true, value: 6 });
    const failure = err('nope');
    expect(map(failure, () => 1)).toBe(failure);
    expect(mapErr(failure, (reason) => reason.toUpperCase())).toEqual({
      ok: false,
      error: 'NOPE',
    });
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(failure)).toBe(true);
    expect(unwrapOr(failure, 'fallback')).toBe('fallback');
  });

  test('tryCatch normalises sync throws into UltimateError', () => {
    const result = tryCatch((): string => {
      throw new UltimateError({ code: 'X_INTERNAL', cause: 'boom', fix: 'x verify' });
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('X_INTERNAL');
      expect(result.error.fix).toBe('x verify');
    }
  });

  test('tryCatch handles async functions', async () => {
    const resolved = await tryCatch(async () => {
      await Bun.sleep(1);
      return 'done';
    });
    expect(resolved).toEqual({ ok: true, value: 'done' });

    const rejected = await tryCatch(async () => {
      await Bun.sleep(1);
      throw new RangeError('out of range');
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.cause).toBe('RangeError: out of range');
  });

  test('unwrap throws a framework error, never a bare one', () => {
    expect(() => unwrap(err('plain string failure'))).toThrow(/X_INTERNAL/);
  });
});
