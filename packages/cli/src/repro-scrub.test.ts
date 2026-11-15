// The scrubber's edges: which env values it hides (secret-named, URLs, dotenv files) and which it
// leaves (a process var like NODE_ENV), a URL's credentials in every encoding, query values,
// emails and IPs, a host only as a whole name and never as a path segment, and paths made relative.

import { describe, expect, test } from 'bun:test';
import type { ScrubSources } from './repro-scrub';
import { hostOf, scrubberFor } from './repro-scrub';

const SOURCES: ScrubSources = {
  root: 'C:\\work\\shop',
  homes: ['/home/ada'],
  env: [
    { name: 'PORT', value: '3000', from: 'process' },
    { name: 'NODE_ENV', value: 'production', from: 'process' },
    { name: 'ADMIN_PIN', value: '4821', from: 'process' },
    { name: 'STRIPE_KEY', value: 'sk_live_abc123', from: 'process' },
    { name: 'REDIS_URL', value: 'redis://cache.corp.test:6379', from: 'process' },
    {
      name: 'DATABASE_URL',
      value: 'postgres://app%40corp:p%40ss-9@db.corp.test/d',
      from: 'process',
    },
    { name: 'FEATURE_LABEL', value: 'quarterly-launch', from: 'dotenv' },
  ],
  hosts: ['box', 'core'],
};

/** Base64 of the UTF-8 bytes — what a Basic header holds for a password outside Latin-1. */
const utf8Base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('scrubberFor', () => {
  test('a value outside Latin-1 builds a scrubber, hidden raw and as UTF-8 base64', () => {
    const scrub = scrubberFor({
      ...SOURCES,
      env: [
        { name: 'SMTP_PASSWORD', value: 'pässwörd€', from: 'process' },
        { name: 'MAIL_URL', value: 'smtp://u:p%C3%A4ss%E2%82%AC@mail.corp.test', from: 'process' },
      ],
    });
    const out = String(
      scrub.value(`a pässwörd€ b ${utf8Base64('pässwörd€')} c päss€ d ${utf8Base64('u:päss€')}`),
    );
    for (const leaked of ['pässwörd€', utf8Base64('pässwörd€'), 'päss€', utf8Base64('u:päss€')]) {
      expect(out).not.toContain(leaked);
    }
  });

  test('a value with surrounding whitespace is found as the app holds it, trimmed', () => {
    const scrub = scrubberFor({
      ...SOURCES,
      env: [{ name: 'API_TOKEN', value: 'tok_abcdef123\n', from: 'dotenv' }],
    });
    expect(scrub.value('sent tok_abcdef123 twice')).toBe('sent [env:API_TOKEN] twice');
  });

  test('a secret-named value of any length, an env URL and a dotenv value are hidden', () => {
    const scrub = scrubberFor(SOURCES);
    expect(
      scrub.value({ pin: 'pin 4821', key: 'sk_live_abc123', label: 'quarterly-launch' }),
    ).toEqual({
      pin: 'pin [env:ADMIN_PIN]',
      key: '[env:STRIPE_KEY]',
      label: '[env:FEATURE_LABEL]',
    });
    expect(scrub.report().env).toEqual(['ADMIN_PIN', 'FEATURE_LABEL', 'STRIPE_KEY']);
  });

  test('a process value that names no secret stays: NODE_ENV=production rewrites nothing', () => {
    const scrub = scrubberFor(SOURCES);
    expect(scrub.value({ production: 'on production, port 3000' })).toEqual({
      production: 'on production, port 3000',
    });
    expect(scrub.report().env).toEqual([]);
  });

  test("an env URL's user and password are hidden raw, decoded and as Basic auth", () => {
    const scrub = scrubberFor(SOURCES);
    const basic = btoa('app@corp:p@ss-9');
    const text = `u=app@corp p=p@ss-9 raw=p%40ss-9 Authorization: Basic ${basic} k=${btoa('sk_live_abc123')}`;
    const out = String(scrub.value(text));
    for (const leaked of ['app@corp', 'p@ss-9', 'p%40ss-9', basic, btoa('sk_live_abc123')]) {
      expect(out).not.toContain(leaked);
    }
  });

  test('any URL loses its credentials and its query values, in data and in a frame', () => {
    const scrub = scrubberFor(SOURCES);
    const url = 'https://u:pw@api.vendor.test/v1?token=abc&page=2#top';
    expect(scrub.value(url)).toBe(
      'https://[cred]@api.vendor.test/v1?token=[redacted]&page=[redacted]#top',
    );
    expect(scrub.location(`fetch ${url} failed`)).toBe(
      'fetch https://[cred]@api.vendor.test/v1?token=[redacted]&page=[redacted]#top failed',
    );
  });

  test('an email and an IPv4 or IPv6 address are replaced; times and versions are not', () => {
    const scrub = scrubberFor(SOURCES);
    expect(
      scrub.value('mail ada.l+x@example.org from 10.0.0.12 and fe80::1 or 2001:db8::8a2e:370:7334'),
    ).toBe('mail [email] from [ip] and [ip] or [ip]');
    expect(scrub.value('at 12:30:45 on 31.27.0 via Code::Add')).toBe(
      'at 12:30:45 on 31.27.0 via Code::Add',
    );
  });

  test('a host is replaced as a whole name, any case, never after a single / or an @', () => {
    const scrub = scrubberFor(SOURCES);
    expect(scrub.value('BOX checkbox Cache.Corp.Test')).toBe('[host] checkbox [host]');
    expect(scrub.value("import '@ultimat3/core' from /srv/core")).toBe(
      "import '@ultimat3/core' from /srv/core",
    );
    expect(scrub.value('https://core/x')).toBe('https://[host]/x');
  });

  test('a Windows root in either separator, and the home directory', () => {
    const scrub = scrubberFor(SOURCES);
    expect(
      scrub.location('at x (C:\\work\\shop\\apps\\a.ts:1:2) at y (C:/work/shop/b.ts:3:4)'),
    ).toBe('at x (.\\apps\\a.ts:1:2) at y (./b.ts:3:4)');
    expect(scrub.location('read /home/ada/.npmrc')).toBe('read ~/.npmrc');
  });

  test('a location keeps an HTTP path and cuts a file path or a system root', () => {
    const scrub = scrubberFor(SOURCES);
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
