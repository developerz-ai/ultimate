// The scrubber's edges: a short flag value is left alone but a short secret is not, a host is a
// whole name, a Windows root is found in either separator, and an HTTP path in a cause survives
// while a file path does not.

import { describe, expect, test } from 'bun:test';
import { hostOf, scrubberFor } from './repro-scrub';

const scrubber = () =>
  scrubberFor({
    root: 'C:\\work\\shop',
    homes: ['/home/ada'],
    env: [
      ['PORT', '3000'],
      ['ADMIN_PIN', '4821'],
      ['REDIS_URL', 'redis://cache.corp.test:6379'],
    ],
    hosts: ['box'],
  });

describe('scrubberFor', () => {
  test('a flag-length value stays, a secret-named one of any length does not', () => {
    const scrub = scrubber();
    expect(scrub.value({ port: 'on 3000', pin: 'pin 4821' })).toEqual({
      port: 'on 3000',
      pin: 'pin [env:ADMIN_PIN]',
    });
    expect(scrub.report().env).toEqual(['ADMIN_PIN']);
  });

  test('a host is replaced as a whole name, any case, and an env URL names one', () => {
    const scrub = scrubber();
    expect(scrub.value('BOX checkbox Cache.Corp.Test')).toBe('[host] checkbox [host]');
    expect(scrub.report().hosts).toBe(2);
  });

  test('a Windows root in either separator, and the home directory', () => {
    const scrub = scrubber();
    expect(
      scrub.location('at x (C:\\work\\shop\\apps\\a.ts:1:2) at y (C:/work/shop/b.ts:3:4)'),
    ).toBe('at x (.\\apps\\a.ts:1:2) at y (./b.ts:3:4)');
    expect(scrub.location('read /home/ada/.npmrc')).toBe('read ~/.npmrc');
  });

  test('a location keeps an HTTP path and cuts a file path or a system root', () => {
    const scrub = scrubber();
    expect(scrub.location('POST /api/posts failed')).toBe('POST /api/posts failed');
    expect(scrub.location('open /etc/secrets failed')).toBe('open <abs>/secrets failed');
    expect(scrub.location('at f (/srv/app/node_modules/@ultimat3/core/src/a.ts:1:1)')).toBe(
      'at f (node_modules/@ultimat3/core/src/a.ts:1:1)',
    );
    expect(scrub.location('at g (D:\\agent\\x.js:2:2)')).toBe('at g (<abs>/x.js:2:2)');
  });

  test('hostOf reads a URL or a DSN, never a loopback', () => {
    expect(hostOf('postgres://u:p@DB.Example.test:5432/x')).toBe('db.example.test');
    expect(hostOf('http://localhost:3000')).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
  });
});
