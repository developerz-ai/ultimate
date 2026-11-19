// The three CLI errors nothing else in this suite constructs. Each is thrown on a path a
// developer meets before anything else works — a red gate, an old Bun, a boot that fell back to
// the embedded disk — so what is pinned is the two lines a reader acts on: `cause` and `fix`.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { requireBunVersion } from './app-root';
import {
  BadFlagError,
  BunVersionError,
  FrameworkScriptBuildFailedError,
  LocalDiskUnsafeError,
  MissingSubcommandError,
  UnknownCommandError,
  VerifyFailedError,
} from './errors';
import { NoTestFilesError } from './errors-suite';
import { thrownBy } from './thrown-by-fixture';

describe('unit · a fix never starts a whole suite by accident', () => {
  test.each(['test', 'verify'])('a typo nearest x %s gets its help, not a run', (name) => {
    const { fix } = new UnknownCommandError({ path: 'tset', known: [name], suggestion: name });
    expect(fix).toStartWith(`x ${name} --help`);
  });

  test('any other nearest command is still the command', () => {
    expect(new UnknownCommandError({ path: 'rotes', known: [], suggestion: 'routes' }).fix).toBe(
      'x routes',
    );
  });

  test('a selection that matched nothing points at the tests the edits reach', () => {
    const { fix } = new NoTestFilesError({ root: '/app', filter: 'nosuchfile' });
    expect(fix).toStartWith('x test --affected --dirty');
  });
});

describe('VerifyFailedError', () => {
  test('counts the failed steps and names every one of them', () => {
    const error = new VerifyFailedError({ failed: ['typecheck', 'drift', 'unit'] });
    expect(error.code).toBe('X_VERIFY_FAILED');
    expect(error.cause).toBe('3 verify step(s) failed: typecheck, drift, unit');
    // The per-step fixes live on the step findings; this one has to reach them.
    expect(error.fix).toBe('x verify --json');
    expect(error.docs).toBe(ERROR_DOCS_URL);
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

describe('FrameworkScriptBuildFailedError', () => {
  test('one code, and the cause names WHICH framework script would not build', () => {
    for (const what of ['sync worker', 'page boot'] as const) {
      const error = new FrameworkScriptBuildFailedError({ what, entry: 'src/x.ts', logs: 'boom' });
      expect(error.code).toBe('X_BUILD_FAILED');
      expect(error.cause).toContain(`the ${what} (src/x.ts)`);
    }
  });
});

// A suggestion is a whole invocation, and some carry the reader's own word: `x db branch crate
// $(id)` was answered `x db branch create $(id)`, which runs `id` on paste. Each word is quoted,
// so the line stays the invocation it names and nothing in it is live.
describe('unit · an invocation in a fix is inert word by word', () => {
  test('a suggestion keeps its words and closes off a hostile one', () => {
    const error = new UnknownCommandError({
      path: 'db branch crate',
      known: ['create'],
      suggestion: 'db branch create $(id)',
    });
    expect(error.fix).toBe("x db branch create '$(id)'");
    expect(new UnknownCommandError({ path: 'g', known: [], suggestion: 'g route posts' }).fix).toBe(
      'x g route posts',
    );
  });

  test('a command path in the default fixes is quoted word by word', () => {
    expect(new BadFlagError({ flag: 'x', command: 'g resource', reason: 'r' }).fix).toBe(
      'x g resource --help',
    );
    expect(new MissingSubcommandError({ command: 'db `id`', known: [] }).fix).toBe(
      "x help db '`id`'",
    );
  });
});
