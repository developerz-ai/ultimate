import { describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { UltimateError } from './errors';
import { createLogger } from './logger';
import { isSecret, REDACTED, revealOptionalSecret, revealSecret, secret } from './secret';

const DSN = 'postgres://user:hunter2@db.internal/app';

describe('secret', () => {
  test('redacts on every path a value can escape through', () => {
    const boxed = secret(DSN, 'DATABASE_URL');
    expect(String(boxed)).toBe(REDACTED);
    expect(`${boxed}`).toBe(REDACTED);
    expect(JSON.stringify({ dsn: boxed })).toBe('{"dsn":"[redacted]"}');
    expect(Bun.inspect(boxed)).not.toContain('hunter2');
    expect(JSON.stringify({ ...boxed })).not.toContain('hunter2');
    expect(Object.values(boxed)).toEqual(['DATABASE_URL']);
  });

  test('reveals only through revealSecret', () => {
    const boxed = secret(DSN);
    expect(revealSecret(boxed)).toBe(DSN);
    expect(revealOptionalSecret(undefined)).toBeUndefined();
    expect(revealOptionalSecret(boxed)).toBe(DSN);
    expect(isSecret(boxed)).toBe(true);
    expect(isSecret(DSN)).toBe(false);
    expect(isSecret(null)).toBe(false);
  });

  test('the logger redacts a secret under a key nobody listed', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      clock: frozenClock('2026-08-11T00:00:00.000Z'),
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    // `dsn` is not in the redaction list — key-name redaction alone would print the value.
    logger.info('boot', { dsn: secret(DSN), nested: { conn: secret(DSN) }, list: [secret(DSN)] });

    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('hunter2');
    expect(lines[0]?.['dsn']).toBe(REDACTED);
    expect(lines[0]?.['nested']).toEqual({ conn: REDACTED });
    expect(lines[0]?.['list']).toEqual([REDACTED]);
  });

  test('an error carrying a secret in meta serialises redacted', () => {
    const error = new UltimateError({
      code: 'X_INTERNAL',
      cause: 'connect failed',
      fix: 'x doctor --json',
      meta: { dsn: secret(DSN) },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('hunter2');
  });

  test('is frozen, so a secret cannot be replaced in place', () => {
    const boxed = secret(DSN);
    expect(Object.isFrozen(boxed)).toBe(true);
    expect(() => {
      (boxed as { label: string }).label = 'other';
    }).toThrow();
  });
});
