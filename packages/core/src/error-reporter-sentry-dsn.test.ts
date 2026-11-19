// A DSN the parser refuses is described, never echoed: a legacy `key:secret@` DSN carries a
// credential, and the refusal lands in a log line and an error's `meta` where nothing redacts it.

import { describe, expect, test } from 'bun:test';
import { parseSentryDsn } from './error-reporter-sentry';
import { isUltimateError } from './errors';

/** The refusal's cause and meta, rendered as one string to search. */
function refusalText(dsn: string): string {
  try {
    parseSentryDsn(dsn);
  } catch (error) {
    if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
    expect(error.code).toBe('X_ERROR_REPORTER_DSN_INVALID');
    return `${error.cause} ${JSON.stringify(error.meta)}`;
  }
  return expect.unreachable('the DSN was accepted');
}

describe('a refused DSN never echoes its secret', () => {
  test('a scheme-less key:secret DSN never echoes the secret', () => {
    // `new URL` reads `pub:` as the scheme and `sekrit@host/1` as an opaque path.
    const text = refusalText('pub:sekrit@errors.example.com/1');
    expect(text).not.toContain('sekrit');
    expect(text).not.toContain('pub:');
  });

  test('an http DSN with no key names where it points, still without userinfo', () => {
    const text = refusalText('https://:sekrit@errors.example.com/');
    expect(text).not.toContain('sekrit');
    expect(text).toContain('errors.example.com');
  });
});
