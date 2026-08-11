import { afterAll, describe, expect, test } from 'bun:test';
import {
  CursorInvalidError,
  configureCursorSigning,
  decodeCursor,
  encodeCursor,
  usesDevCursorSecret,
} from './cursor';

const position = { scope: 'posts:acme', key: ['2026-01-01T00:00:00.000Z', 7], id: 'p_9' };

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

afterAll(() => {
  configureCursorSigning('ultimate-dev-cursor-secret');
});

describe('the one cursor codec', () => {
  test('round trips a page position and stays opaque', () => {
    const cursor = encodeCursor(position);
    expect(cursor).not.toContain('posts');
    expect(cursor).not.toContain('p_9');
    expect(decodeCursor(cursor, 'posts:acme')).toEqual(position);
  });

  test('survives sort values outside latin-1', () => {
    const cursor = encodeCursor({ scope: 's', key: ['café — piñata 🎉'], id: 'p_1' });
    expect(decodeCursor(cursor, 's').key[0]).toBe('café — piñata 🎉');
  });

  test('a tampered cursor is X_CURSOR_INVALID, not a wrong page', () => {
    const [body = '', signature = ''] = encodeCursor(position).split('.');
    const forged = encodeCursor({ ...position, id: 'p_999' }).split('.')[0] ?? '';

    // A signature ending in `0` would make `+ '0'` no tamper at all — the test has to flip to a
    // digit it does not already end in, or it passes one run in sixteen for the wrong reason.
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

    for (const cursor of [
      `${forged}.${signature}`,
      `${body}.${flipped}`,
      `${body}.`,
      body,
      'garbage',
      '',
    ]) {
      expect(codeOf(() => decodeCursor(cursor, 'posts:acme'))).toBe('X_CURSOR_INVALID');
    }
  });

  // The wire format is a compatibility contract: two instances of the same app must accept each
  // other's cursors, so the test signs its own bodies rather than trusting `encodeCursor` to
  // agree with itself. That is also the only way to reach the shape check behind a valid
  // signature — what an older build's payload would hit after a redeploy.
  test('a correctly signed payload that is not a cursor is still refused', () => {
    configureCursorSigning('known-secret');
    const signed = (payload: unknown): string => {
      const body = btoa(JSON.stringify(payload))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
      const mac = new Bun.CryptoHasher('sha256', 'known-secret').update(body).digest('hex');
      return `${body}.${mac.slice(0, 32)}`;
    };

    expect(decodeCursor(signed(['s', 'p_1', ['a']]), 's')).toEqual({
      scope: 's',
      id: 'p_1',
      key: ['a'],
    });
    for (const payload of [{ scope: 's' }, ['s', 'p_1'], ['s', 'p_1', 'a'], [1, 'p_1', []], 'x']) {
      expect(codeOf(() => decodeCursor(signed(payload), 's'))).toBe('X_CURSOR_INVALID');
    }
  });

  test('a cursor from another read cannot page this one', () => {
    const cursor = encodeCursor(position);
    expect(() => decodeCursor(cursor, 'posts:other')).toThrow(CursorInvalidError);
    expect(codeOf(() => decodeCursor(cursor, 'posts:other'))).toBe('X_CURSOR_INVALID');
  });

  test('rotating the secret invalidates every open cursor', () => {
    const cursor = encodeCursor(position);
    configureCursorSigning('rotated-secret');
    expect(codeOf(() => decodeCursor(cursor, 'posts:acme'))).toBe('X_CURSOR_INVALID');
    // And the new secret is what signs from now on.
    expect(decodeCursor(encodeCursor(position), 'posts:acme').id).toBe('p_9');
    expect(usesDevCursorSecret()).toBe(false);
  });

  // What `x doctor` reads to decide whether a deploy can be paged by a forged cursor. The
  // detector has to recognise the exact literal the published package ships — "not rotated" is
  // not the same question, and an app that never calls `configureCursorSigning` inherits it.
  test('the shipped dev key is detectable by the literal an unconfigured app inherits', () => {
    configureCursorSigning('ultimate-dev-cursor-secret');
    expect(usesDevCursorSecret()).toBe(true);
  });

  test('the failure names the fix, in three lines', () => {
    const error = new CursorInvalidError('signature does not match');
    expect(error.format()).toBe(
      [
        'X_CURSOR_INVALID: pagination cursor is malformed, tampered with or from another query',
        '  cause: cursor rejected: signature does not match',
        '  fix:   drop the cursor and request the first page again (after: null)',
      ].join('\n'),
    );
  });
});
