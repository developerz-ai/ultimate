// 31.20.0: the app's session authenticator answers a stale, revoked or forged cookie `null` instead
// of throwing, so a signed-out socket is closed and sign-in opens for a stale cookie. Both shapes
// of `apps/web/app/auth/authenticator.ts` (`x new`'s, `x g sign-in`'s) and their tests.

import type { Codemod, CodemodApp } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const SOURCE = 'apps/web/app/auth/authenticator.ts';
const TEST = 'apps/web/app/auth/authenticator.test.ts';

const lines = (...text: readonly string[]): string => text.join('\n');

const CATCH = lines(
  '    try {',
  '      return await authenticate(TARGET, token);',
  '    } catch (error) {',
  '      if (isSessionRefusal(error)) return null;',
  '      throw error;',
  '    }',
  '  };',
);

const SIGNED_OUT_TEST = (name: string, check: string): string =>
  lines(
    "unitTest('a signed-out cookie is nobody, so its socket is closed on re-check', async () => {",
    '  const auth = memoryAuth();',
    '  await register(auth(), {',
    "    email: 'ada@example.com',",
    '    password: PASSWORD,',
    '    orgId: DEMO_ORG_ID,',
    "    roles: ['member'],",
    '  });',
    "  const { token } = await login(auth(), { email: 'ada@example.com', password: PASSWORD });",
    '  await logout(auth(), token);',
    `  const ${name} = requestWith({ [auth().sessions.policy.cookieName]: token });`,
    check,
    '});',
  );

const AUTH_IMPORT: SnippetEdit = {
  from: "import { defineAuth, login, memoryAuthAdapter, register } from '@ultimat3/auth';",
  to: "import { defineAuth, login, logout, memoryAuthAdapter, register } from '@ultimat3/auth';",
};

const NULL_NOT_THROW =
  '  // `null`, not a throw: thrown, a stale cookie was a 401 on the sign-in page itself.';

/** `x new`'s authenticator: development falls back to the dev viewer, a cookie never does. */
const SCAFFOLD: readonly SnippetEdit[] = [
  {
    from: "import { type Actor, logger, tryResolveEnvironment } from '@ultimat3/core';",
    to: "import { type Actor, isSessionRefusal, logger, tryResolveEnvironment } from '@ultimat3/core';",
  },
  {
    from: lines(
      " * A session cookie is that session's user, or a refusal — never a fallback to anyone else:",
      ' * `X_SESSION_EXPIRED` for a session past its absolute or idle expiry, `X_UNAUTHENTICATED` for',
      ' * one that is unknown, revoked or forged, or whose user is disabled. No cookie is the development',
      ' * viewer or nobody.',
    ),
    to: lines(
      " * A session cookie is that session's user, or nobody — never a fallback to anyone else. A session",
      ' * past its expiry, or one unknown, revoked or forged, or whose user is disabled, is a refusal',
      ' * `authenticate()` THROWS (`isSessionRefusal`: `X_SESSION_EXPIRED`, `X_UNAUTHENTICATED`), and it',
      ' * is answered `null`: a stale cookie is an anonymous visitor, so sign-in still opens and a live',
      ' * socket it opened is closed. Anything else it throws — a session store that is down — is not an',
      ' * answer about this visitor and propagates. No cookie is the development viewer or nobody.',
    ),
    optional: true,
  },
  {
    from: lines(
      '    if (token !== null && token.length > 0) return await authenticate(auth, token);',
      '    return options.development ? devAuthenticate(request) : null;',
      '  };',
    ),
    to: lines(
      '    if (token === null || token.length === 0) {',
      '      return options.development ? devAuthenticate(request) : null;',
      '    }',
      CATCH.replace('TARGET', 'auth'),
    ),
  },
];

const SCAFFOLD_TEST: readonly SnippetEdit[] = [
  AUTH_IMPORT,
  {
    from: lines(
      "unitTest('a cookie naming no live session is refused, never answered as the viewer', async () => {",
      '  const auth = memoryAuth();',
      "  const request = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });",
      '  await expect(sessionAuthenticator({ auth, development: true })(request)).rejects.toMatchObject({',
      "    code: 'X_UNAUTHENTICATED',",
      '  });',
      '});',
    ),
    to: lines(
      "unitTest('a cookie naming no live session is nobody, never answered as the viewer', async () => {",
      '  const auth = memoryAuth();',
      "  const request = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });",
      NULL_NOT_THROW,
      '  expect(await sessionAuthenticator({ auth, development: true })(request)).toBeNull();',
      '});',
      '',
      SIGNED_OUT_TEST(
        'request',
        lines(
          '  for (const development of [true, false]) {',
          '    expect(await sessionAuthenticator({ auth, development })(request)).toBeNull();',
          '  }',
        ),
      ),
    ),
  },
];

/** `x g sign-in`'s authenticator: no development fallback at all. */
const SIGN_IN: readonly SnippetEdit[] = [
  {
    from: "import type { Actor } from '@ultimat3/core';",
    to: "import { type Actor, isSessionRefusal } from '@ultimat3/core';",
  },
  {
    from: lines(
      " * A session cookie is that session's user, or a refusal — never a fallback to anyone else:",
      ' * `X_SESSION_EXPIRED` past its expiry, `X_UNAUTHENTICATED` for one unknown, revoked or forged.',
    ),
    to: lines(
      " * A session cookie is that session's user, or nobody — never a fallback to anyone else. A session",
      ' * past its expiry, or one unknown, revoked or forged, is a refusal `authenticate()` THROWS',
      ' * (`isSessionRefusal`: `X_SESSION_EXPIRED`, `X_UNAUTHENTICATED`), answered `null`: a stale',
      ' * cookie is an anonymous visitor, so sign-in still opens and a live socket it opened is closed.',
      ' * Anything else it throws — a session store that is down — propagates.',
    ),
    optional: true,
  },
  {
    from: lines(
      '    return token !== null && token.length > 0 ? await authenticate(resolved, token) : null;',
      '  };',
    ),
    to: lines(
      '    if (token === null || token.length === 0) return null;',
      CATCH.replace('TARGET', 'resolved'),
    ),
  },
];

const SIGN_IN_TEST: readonly SnippetEdit[] = [
  {
    from: '// A session cookie is the user it was issued to; a bad one is refused; none is nobody.',
    to: lines(
      '// A session cookie is the user it was issued to; a bad, expired or signed-out one is nobody, and',
      '// so is none.',
    ),
    optional: true,
  },
  AUTH_IMPORT,
  {
    from: lines(
      "unitTest('a forged cookie is refused, and no cookie is anonymous', async () => {",
      '  const auth = memoryAuth();',
      "  const forged = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });",
      '  await expect(sessionAuthenticator(auth)(forged)).rejects.toMatchObject({',
      "    code: 'X_UNAUTHENTICATED',",
      '  });',
      '  expect(await sessionAuthenticator(auth)(requestWith({}))).toBeNull();',
      '});',
    ),
    to: lines(
      "unitTest('a forged cookie is nobody, and no cookie is anonymous', async () => {",
      '  const auth = memoryAuth();',
      "  const forged = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });",
      NULL_NOT_THROW,
      '  expect(await sessionAuthenticator(auth)(forged)).toBeNull();',
      '  expect(await sessionAuthenticator(auth)(requestWith({}))).toBeNull();',
      '});',
      '',
      SIGNED_OUT_TEST('cookie', '  expect(await sessionAuthenticator(auth)(cookie)).toBeNull();'),
    ),
  },
];

/** Each shape's edits by file: what the codemod runs, and what its test runs backwards. */
export const AUTHENTICATOR_EDITS = {
  scaffold: { [SOURCE]: SCAFFOLD, [TEST]: SCAFFOLD_TEST },
  signIn: { [SOURCE]: SIGN_IN, [TEST]: SIGN_IN_TEST },
} as const;

/** `x g sign-in` rewrote the authenticator with no development fallback: its own signature. */
const isSignIn = async (app: CodemodApp): Promise<boolean> =>
  ((await app.read(SOURCE)) ?? '').includes('(auth: () => Auth) =>');

export const codemod: Codemod = {
  id: 'authenticator-session-refusal',
  since: '31.20.0',
  summary:
    'apps/web/app/auth/authenticator.ts answers a stale, revoked or forged session cookie null instead of throwing (and its test says so)',
  async run(app) {
    const signIn = await isSignIn(app);
    return mergeResults([
      await editSnippets(app, SOURCE, signIn ? SIGN_IN : SCAFFOLD),
      await editSnippets(app, TEST, signIn ? SIGN_IN_TEST : SCAFFOLD_TEST),
    ]);
  },
};
