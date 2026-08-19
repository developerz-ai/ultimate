// The three CLI errors nothing else in this suite constructs. Each is thrown on a path a
// developer meets before anything else works — a red gate, an old Bun, a boot that fell back to
// the embedded disk — so what is pinned is the two lines a reader acts on: `cause` and `fix`.

import { describe, expect, test } from 'bun:test';
import { requireBunVersion } from './app-root';
import { BunVersionError, LocalDiskUnsafeError, VerifyFailedError } from './errors';
import { thrownBy } from './thrown-by';

describe('VerifyFailedError', () => {
  test('counts the failed steps and names every one of them', () => {
    const error = new VerifyFailedError({ failed: ['typecheck', 'drift', 'unit'] });
    expect(error.code).toBe('X_VERIFY_FAILED');
    expect(error.cause).toBe('3 verify step(s) failed: typecheck, drift, unit');
    // The per-step fixes live on the step findings; this one has to reach them.
    expect(error.fix).toBe('x verify --json');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_VERIFY_FAILED');
  });
});

describe('BunVersionError, through the check that raises it', () => {
  test('an older Bun is refused, naming both versions and the upgrade command', () => {
    const thrown = thrownBy(() => {
      requireBunVersion('1.2.9', '1.3.0');
    });
    expect(thrown.code).toBe('X_BUN_VERSION');
    expect(thrown.cause).toBe('Bun 1.2.9 is older than the required 1.3.0');
    expect(thrown.fix).toBe('bun upgrade');
  });

  test('the required version itself passes, and so does anything newer', () => {
    expect(() => {
      requireBunVersion('1.3.0', '1.3.0');
    }).not.toThrow();
    expect(() => {
      requireBunVersion('1.4.0', '1.3.0');
    }).not.toThrow();
    // A prerelease suffix is dropped before the comparison, not read as a fourth component.
    expect(() => {
      requireBunVersion('1.3.0-canary.1', '1.3.0');
    }).not.toThrow();
  });

  test('the error carries the found and required strings verbatim', () => {
    const error = new BunVersionError({ found: '1.0.0', required: '1.3.14' });
    expect(error.cause).toBe('Bun 1.0.0 is older than the required 1.3.14');
  });
});

describe('LocalDiskUnsafeError', () => {
  test('says the disk was a fallback, and names the signing key it would have used', () => {
    const error = new LocalDiskUnsafeError({ environment: 'production', root: '/srv/app/.x' });
    // The shared code, deliberately: @ultimat3/storage already refuses this condition with it.
    expect(error.code).toBe('X_ENV_MISSING');
    expect(error.cause).toContain('this production process fell back to the embedded disk');
    expect(error.cause).toContain('/srv/app/.x');
    expect(error.cause).toContain('STORAGE_SIGNING_SECRET');
    // The fix has to run verbatim: the volume rung is behind a `#`, so a paste is one command.
    expect(error.fix).toStartWith('export S3_ENDPOINT=https://s3.example.com S3_BUCKET=');
    expect(error.fix.slice(0, error.fix.indexOf('#'))).not.toContain('\n');
  });
});
