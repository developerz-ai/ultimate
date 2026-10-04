// What this file still owns after the negotiators moved to their owners: the two config objects
// that say only WHERE the request's locale and zone are read from (the cookie reader is
// `@ultimat3/core`'s `readCookie`, tested there). What a locale or a zone IS is
// asserted in `@ultimat3/i18n` and `@ultimat3/time`; the request path is `locale-stage.test.ts`.
import { describe, expect, test } from 'bun:test';
import { LOCALE_COOKIE } from '@ultimat3/i18n';
import { TIMEZONE_HEADER } from '@ultimat3/time';
import { DEFAULT_LOCALE_CONFIG, DEFAULT_TZ_CONFIG } from './locale';

describe('the request-scoped config', () => {
  // A switcher writes the cookie `@ultimat3/i18n` documents, and a client sets the header
  // `@ultimat3/time` documents. This package spelling either one itself is how `x-locale` shipped
  // beside `LOCALE_COOKIE` and neither side ever read the other.
  test('names come from the owning packages, never from a literal here', () => {
    expect(DEFAULT_LOCALE_CONFIG.cookie).toBe(LOCALE_COOKIE);
    expect(DEFAULT_TZ_CONFIG.header).toBe(TIMEZONE_HEADER);
  });
});
