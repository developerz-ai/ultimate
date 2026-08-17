// Covers `normaliseEmail` and, more importantly, the boundary rule it exists for: every path that
// turns an address into an identity must normalise it BEFORE the adapter sees it, or two adapters
// answer "does this account exist" differently. The three paths are `register`, `login` and the
// OAuth account link — the third had no normalisation at all, and only the memory adapter's own
// lowercasing hid it.

import { describe, expect, test } from 'bun:test';
import { login, register } from './auth';
import { normaliseEmail } from './email';
import { signInWithOAuth } from './oauth-login';
// The `Auth` the other OAuth suites drive, not a fourth one built here — a flow that agrees only
// with its own fixture is what let this divergence live.
import { freshAuth, NOW, profile, tokens } from './oauth-login-fixture';
import { accountKey } from './rate-limit';

const PASSWORD = 'a-Long-Passphrase-42';

describe('normaliseEmail', () => {
  test('trims and folds case, and changes nothing else', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    // A `+tag` is a distinct address a person chose. Merging it merges two accounts.
    expect(normaliseEmail('ada+ci@example.com')).toBe('ada+ci@example.com');
    expect(normaliseEmail('a.d.a@example.com')).toBe('a.d.a@example.com');
  });

  test('the lockout bucket keys the same way the lookup does', () => {
    // Two spellings that resolve to one account must spend one budget, or the per-account limiter
    // is a spray budget multiplier: `Ada@…`, `ADA@…`, ` ada@… ` would each get their own attempts.
    expect(accountKey('  Ada@Example.COM ')).toBe(accountKey('ada@example.com'));
  });
});

describe('an address is normalised before the adapter sees it', () => {
  test('register stores the normalised form and login finds it by any casing', async () => {
    const { adapter, auth } = freshAuth();
    const created = await register(auth, {
      email: '  Ada@Example.COM ',
      password: PASSWORD,
    });
    expect(created.email).toBe('ada@example.com');
    expect((await adapter.findUserByEmail('ada@example.com'))?.id).toBe(created.id);
    const result = await login(auth, {
      email: 'ADA@example.com',
      password: PASSWORD,
    });
    expect(result.session.userId).toBe(created.id);
  });

  test('an OAuth login links the existing account when the provider changes the casing', async () => {
    const { adapter, auth } = freshAuth();
    const created = await register(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    await adapter.updateUser(created.id, { emailVerifiedAt: NOW });

    // The provider's address is carried verbatim out of the id token / userinfo — providers do
    // send display casing. Unnormalised, Postgres finds no row and `createUserFor` mints a SECOND
    // account at the same address, which the case-sensitive unique index happily accepts; that row
    // can then never be reached by `login()`, which lowercases. One person, two accounts, and the
    // one they registered with is the one they stop being able to sign into.
    const result = await signInWithOAuth(auth, {
      profile: profile({ email: 'Ada@Example.COM' }),
      tokens: tokens(),
    });
    expect(result.session.userId).toBe(created.id);
  });

  test('an OAuth signup stores the normalised address, so the next login by any casing finds it', async () => {
    const { adapter, auth } = freshAuth();
    const result = await signInWithOAuth(auth, {
      profile: profile({ email: ' Grace@Example.COM ', providerAccountId: '583232' }),
      tokens: tokens(),
    });
    expect((await adapter.findUserById(result.session.userId))?.email).toBe('grace@example.com');
  });
});
