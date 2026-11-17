// `redactConfigValue`'s URL edge: the password is cut whole from the userinfo — a raw `@` inside
// it included — while the user and the host stay readable.

import { describe, expect, test } from 'bun:test';
import { REDACTED } from '@ultimat3/core';
import { redactConfigValue } from './config-redact';

describe('redactConfigValue on a URL', () => {
  test('cuts a password holding a raw `@` whole, keeping the user and the host', () => {
    const shown = redactConfigValue({
      db: { url: 'postgres://app:hunter@2secret@db.internal/app' },
    });
    expect(JSON.stringify(shown)).not.toContain('2secret');
    expect(shown).toEqual({ db: { url: `postgres://app:${REDACTED}@db.internal/app` } });
  });

  test('a URL with a user and no password, or no userinfo at all, is left as written', () => {
    for (const url of ['postgres://app@db.internal/app', 'https://host/@user']) {
      expect(redactConfigValue({ url })).toEqual({ url });
    }
  });
});
