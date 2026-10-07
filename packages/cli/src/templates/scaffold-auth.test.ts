// The scaffold's answer to "who is this?" is the REAL one — a session cookie resolved by
// `@ultimat3/auth` — in every environment, with the development viewer only as what a request with
// no session is answered as under `x dev`. Held here over the strings `x new` writes; the emitted
// tests run inside the scaffold itself (CI's scaffold-smoke, `scripts/scaffold-gate.ts`).

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';
import { names } from './naming';
import { repoFiles } from './scaffold-repo';

const files = (): readonly { path: string; contents: string | Uint8Array }[] =>
  planNewApp({ name: 'ledger-demo', example: true });

const text = (path: string): string => {
  const found = files().find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`x new writes no ${path}`);
  return String(found.contents);
};

/** Every emitted text file's code lines — comments carry the prose that names the calls. */
const code = (contents: string): string =>
  contents
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');

describe('unit · the scaffold authenticates through @ultimat3/auth', () => {
  test('the app depends on @ultimat3/auth at the framework version, beside @ultimat3/http', () => {
    const manifest = JSON.parse(
      String(
        repoFiles(names('ledger-demo'), '9.9.9', true).find((f) => f.path === 'package.json')
          ?.contents,
      ),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(manifest.dependencies?.['@ultimat3/auth']).toBe('^9.9.9');
    expect(manifest.dependencies?.['@ultimat3/http']).toBe('^9.9.9');
  });

  test('one module installs the authenticator, and it is the session one', () => {
    const installers = files().filter(
      (file) =>
        typeof file.contents === 'string' &&
        !file.path.endsWith('.test.ts') &&
        code(file.contents).includes('configureAuthenticator('),
    );
    expect(installers.map((file) => file.path)).toEqual(['apps/web/app/auth/authenticator.ts']);
    const authenticator = code(text('apps/web/app/auth/authenticator.ts'));
    expect(authenticator).toContain("from '@ultimat3/auth'");
    expect(authenticator).toContain('authenticate(auth, token)');
  });

  // The real path is installed whatever the environment says; only the no-session fallback is
  // environment-gated, and it fails closed — a process naming no environment is production.
  test('the installer is unconditional; only the development viewer reads the environment', () => {
    const authenticator = code(text('apps/web/app/auth/authenticator.ts'));
    expect(authenticator).toContain("tryResolveEnvironment({ env, fallback: 'production' })");
    expect(authenticator).toMatch(/\ninstallAuthenticator\(\);\n/);
    expect(code(text('apps/web/app/auth/dev-actor.ts'))).not.toContain('configureAuthenticator');
  });

  // Built on first use: the boot scan imports this module before `db()` and the host's shared
  // lockout limiter exist, and `defineAuth` reads both.
  test('the Auth instance is built lazily over the framework tables, never at import', () => {
    const auth = code(text('apps/web/app/auth/auth.ts'));
    expect(auth).toContain('defineAuth({ adapter: postgresAuthAdapter() })');
    expect(auth).toContain('built ??=');
  });

  test('the emitted tests cover the session, the fallback and the install', () => {
    const tests = text('apps/web/app/auth/authenticator.test.ts');
    expect(tests).toContain('memoryAuthAdapter');
    expect(tests).toContain('installAuthenticator(');
    expect(files().map((file) => file.path)).toContain('apps/web/app/auth/dev-actor.test.ts');
  });
});
