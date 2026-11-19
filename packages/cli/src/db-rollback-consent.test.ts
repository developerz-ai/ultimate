// When `x db rollback` needs `ROLLBACK_ALLOW_DESTRUCTIVE` to name what it reverses: a NAMED deploy
// (`namedDeployed`, staging or production), an `ULTIMATE_ENV` that names no environment, and — what
// no environment variable can talk it out of — a database on another machine.

import { describe, expect, test } from 'bun:test';
import { rollbackNeedsConsent } from './db-rollback-consent';

const embedded = { mode: 'embedded', url: 'pglite:///app/.x/pgdata' } as const;
const external = (url: string) => ({ mode: 'external', url }) as const;

describe('rollbackNeedsConsent', () => {
  test('a named deploy needs the names; development and test do not', () => {
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'production' }, embedded)).toBe(true);
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'staging' }, embedded)).toBe(true);
    expect(rollbackNeedsConsent({ NODE_ENV: 'production' }, embedded)).toBe(true);
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'development' }, embedded)).toBe(false);
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'test' }, embedded)).toBe(false);
    expect(rollbackNeedsConsent({}, embedded)).toBe(false);
  });

  test('an ULTIMATE_ENV that is no environment never reads as "not production"', () => {
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'prod' }, embedded)).toBe(true);
  });

  test('an external non-loopback database needs the names even with no environment set', () => {
    // `DATABASE_URL=<prod> x db rollback` from a shell that names nothing resolved development.
    const remote = external('postgres://app:secret@db.prod.example.com:5432/app');
    expect(rollbackNeedsConsent({}, remote)).toBe(true);
    expect(rollbackNeedsConsent({ ULTIMATE_ENV: 'development' }, remote)).toBe(true);
    expect(rollbackNeedsConsent({}, external('postgres://app@10.0.0.7/app'))).toBe(true);
    expect(rollbackNeedsConsent({}, external('postgres://app@db/app'))).toBe(true);
  });

  test("this machine's database is the developer's own: loopback and a local socket", () => {
    for (const url of [
      'postgres://app@localhost:5432/app',
      'postgres://app@127.0.0.1/app',
      'postgres://app@[::1]/app',
      'postgresql:///app?host=/var/run/postgresql',
    ]) {
      expect({ url, consent: rollbackNeedsConsent({}, external(url)) }).toEqual({
        url,
        consent: false,
      });
    }
  });

  test('a URL that does not parse, or a host query naming another machine, needs the names', () => {
    expect(rollbackNeedsConsent({}, external('not a url'))).toBe(true);
    expect(rollbackNeedsConsent({}, external('postgres:///app?host=db.prod.example.com'))).toBe(
      true,
    );
  });
});
