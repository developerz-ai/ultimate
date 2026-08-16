import { describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { UltimateError } from './errors';
import { createLogger, REDACTED, redactKeys } from './logger';

function capture(level: 'trace' | 'info' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    clock: frozenClock('2026-07-26T10:00:00.000Z'),
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('logger', () => {
  test('emits one JSON line with ts, level and msg', () => {
    const { logger, lines } = capture();
    logger.info('post published', { postId: 'p1' });
    expect(lines[0]).toEqual({
      ts: '2026-07-26T10:00:00.000Z',
      level: 'info',
      msg: 'post published',
      postId: 'p1',
    });
  });

  test('filters below the threshold', () => {
    const { logger, lines } = capture();
    logger.debug('noise');
    logger.warn('signal');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('warn');
  });

  test('child fields are bound and overridable', () => {
    const { logger, lines } = capture();
    const child = logger.child({ queue: 'default', attempt: 1 });
    child.info('picked up', { attempt: 2 });
    expect(lines[0]).toMatchObject({ queue: 'default', attempt: 2 });
  });

  test('redacts secret keys anywhere in the payload', () => {
    redactKeys(['DATABASE_URL']);
    const { logger, lines } = capture();
    logger.info('boot', {
      DATABASE_URL: 'postgres://user:pw@host/db',
      password: 'hunter2',
      nested: { token: 'abc', keep: 'yes' },
    });
    expect(lines[0]).toMatchObject({
      DATABASE_URL: REDACTED,
      password: REDACTED,
      nested: { token: REDACTED, keep: 'yes' },
    });
  });

  /**
   * `isRedactedKey` lowercases the lookup, so three of the eight shipped defaults were stored
   * camelCase and matched nothing — and those three are the exact field names on `OAuthTokens`
   * (`accessToken`, `refreshToken`, `apiKey`). One `logger.info('token exchange', { tokens })`
   * wrote a live access token into the log store for the full retention.
   */
  test('every default redaction key actually matches the field it names', () => {
    const { logger, lines } = capture();
    logger.info('token exchange', {
      apiKey: 'ak_live_1',
      accessToken: 'at_live_1',
      refreshToken: 'rt_live_1',
      api_key: 'ak_live_2',
      access_token: 'at_live_2',
      refresh_token: 'rt_live_2',
      client_secret: 'cs_live_1',
      id_token: 'idt_live_1',
      private_key: 'pk_live_1',
      session_token: 'st_live_1',
      'set-cookie': 'x_session=abc; HttpOnly',
      keep: 'yes',
    });
    const line = lines[0] ?? {};
    for (const [key, value] of Object.entries(line)) {
      if (key === 'ts' || key === 'level' || key === 'msg' || key === 'keep') continue;
      expect([key, value]).toEqual([key, REDACTED]);
    }
    expect(line['keep']).toBe('yes');
  });

  test('serialises UltimateError with the --json shape', () => {
    const { logger, lines } = capture();
    logger.error('failed', {
      error: new UltimateError({ code: 'X_INTERNAL', cause: 'boom', fix: 'x verify' }),
    });
    expect(lines[0]?.['error']).toMatchObject({
      code: 'X_INTERNAL',
      cause: 'boom',
      fix: 'x verify',
      docs: 'https://ultimate.dev/errors/X_INTERNAL',
    });
  });
});
