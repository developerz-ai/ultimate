// The userinfo cut's edges: where a URL parser ends the userinfo (the LAST `@` before the
// authority's end), so a password holding a raw `@` is cut whole, and what is never userinfo.

import { describe, expect, test } from 'bun:test';
import { REDACTED } from './secret';
import { redactUrlPassword, replaceUrlUserinfo } from './url-userinfo';

const dropAll = (text: string): string => replaceUrlUserinfo(text, () => '…');

describe('replaceUrlUserinfo', () => {
  test('ends the userinfo at the LAST `@` before the authority ends, as WHATWG does', () => {
    const url = 'postgres://app:hunter@2secret@db.internal:5432/app';
    expect(new URL(url).hostname).toBe('db.internal');
    expect(dropAll(url)).toBe('postgres://…@db.internal:5432/app');
  });

  test('hands the whole userinfo to the renderer, raw `@` included', () => {
    const seen: string[] = [];
    replaceUrlUserinfo('https://u:p@w@host/x', (userinfo) => {
      seen.push(userinfo);
      return userinfo;
    });
    expect(seen).toEqual(['u:p@w']);
  });

  test('an `@` after the path, query or fragment begins is not userinfo', () => {
    for (const url of [
      'https://host/@user',
      'https://host?to=a@b.test',
      'https://host#a@b',
      'https://host',
    ]) {
      expect(dropAll(url)).toBe(url);
    }
  });

  test('every URL in prose, each to its own authority end', () => {
    expect(dropAll('dial http://u:a@b@proxy:3128 then "//k@cdn.test/x" failed')).toBe(
      'dial http://…@proxy:3128 then "//…@cdn.test/x" failed',
    );
  });
});

describe('redactUrlPassword', () => {
  test('keeps the user, cuts the whole password, leaves a bare user alone', () => {
    expect(redactUrlPassword('nats://bus:p@ss:w@nats.internal:4222')).toBe(
      `nats://bus:${REDACTED}@nats.internal:4222`,
    );
    expect(redactUrlPassword('postgres://app@db/app')).toBe('postgres://app@db/app');
  });
});
