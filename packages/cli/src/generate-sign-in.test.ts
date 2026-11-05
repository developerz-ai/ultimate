// `x g sign-in`, run against a real `x new` scaffold: each shape writes its listed files, a second
// run refuses and writes nothing, the OIDC swap drops `x new`'s development viewer only while it is
// still `x new`'s, and the spelling is exactly one of two flags with no name.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { signInConfigEdit } from './generate-sign-in-config';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-sign-in-'));
  await writeNewApp(root, { name: 'probe', example: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly ok: boolean;
  readonly files: readonly string[];
  readonly codes: readonly string[];
}

const run = async (...argv: string[]): Promise<Run> => {
  const out: string[] = [];
  const code = await dispatch({
    argv: [...argv, '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  const parsed = JSON.parse(out.join('\n')) as {
    ok: boolean;
    data?: { files?: string[] };
    findings?: { code: string }[];
    error?: { code: string };
  };
  return {
    code,
    ok: parsed.ok,
    files: parsed.data?.files ?? [],
    codes: [
      ...(parsed.findings ?? []).map((finding) => finding.code),
      ...(parsed.error === undefined ? [] : [parsed.error.code]),
    ],
  };
};

const exists = (path: string): Promise<boolean> => Bun.file(join(root, path)).exists();
const read = (path: string): Promise<string> => Bun.file(join(root, path)).text();
const AUTH = 'apps/web/app/auth';

describe('x g sign-in --password', () => {
  test('writes the page, the two legs, sign-out and the guard, and lists the actions', async () => {
    const result = await run('g', 'sign-in', '--password');
    expect(result.codes).toEqual([]);
    for (const path of [
      `${AUTH}/sign-in/page.tsx`,
      `${AUTH}/sign-in/second-factor/page.tsx`,
      `${AUTH}/actions/create-session.ts`,
      `${AUTH}/actions/confirm-session.ts`,
      `${AUTH}/actions/destroy-session.ts`,
      `${AUTH}/sign-in-guard.ts`,
      `${AUTH}/sign-in-flow.ts`,
      `${AUTH}/sign-in-challenge.ts`,
    ]) {
      expect(result.files).toContain(path);
      expect(await exists(path)).toBe(true);
    }
    // The actions reach the API index, the catalog its keys, the config its sign-in page.
    expect(await read('apps/web/api/index.ts')).toContain('createSession');
    expect(await read('packages/i18n/catalogs/en.json')).toContain('"signIn"');
    expect(await read('app.config.ts')).toContain("auth: { signInPath: '/auth/sign-in' },");
    expect(await read(`${AUTH}/sign-in-guard.ts`)).toContain("['ULTIMATE_SECRETS_KEY']");
    // The guard runs where a throw stops the boot: the runtime, imported before a port is bound.
    expect(await read('apps/web/runtime.ts')).toContain('assertSignInConfigured(process.env);');
    // A password app keeps the development viewer: there is no sign-up page to make a user with.
    expect(await exists(`${AUTH}/dev-actor.ts`)).toBe(true);
  }, 60_000);

  test('a second run refuses, and writes nothing', async () => {
    expect((await run('g', 'sign-in', '--password')).ok).toBe(true);
    const page = await read(`${AUTH}/sign-in/page.tsx`);
    await Bun.write(join(root, `${AUTH}/sign-in/page.tsx`), `${page}// the author's\n`);
    const again = await run('g', 'sign-in', '--password');
    expect(again.ok).toBe(false);
    expect(again.codes).toContain('X_GENERATE_CONFLICT');
    expect(await read(`${AUTH}/sign-in/page.tsx`)).toEndWith("// the author's\n");
  }, 60_000);
});

describe('x g sign-in --oidc', () => {
  test('writes the provider, its routes and the runtime, declares its env and swaps the viewer out', async () => {
    const result = await run('g', 'sign-in', '--oidc', 'corp-sso');
    expect(result.codes).toEqual([]);
    for (const path of [
      `${AUTH}/oidc.ts`,
      `${AUTH}/sign-in-routes.ts`,
      'apps/web/runtime.ts',
      `${AUTH}/sign-in/page.tsx`,
    ]) {
      expect(await exists(path)).toBe(true);
    }
    const config = await read('app.config.ts');
    for (const key of ['CORP_SSO_ISSUER', 'CORP_SSO_CLIENT_ID', 'CORP_SSO_CLIENT_SECRET']) {
      expect(config).toContain(`${key}: {`);
    }
    expect(await exists(`${AUTH}/dev-actor.ts`)).toBe(false);
    expect(await exists(`${AUTH}/dev-actor.test.ts`)).toBe(false);
    const authenticator = await read(`${AUTH}/authenticator.ts`);
    expect(authenticator).not.toContain('devAuthenticate');
  }, 60_000);

  test('an authenticator the author edited is never overwritten: the swap is a finding', async () => {
    const path = join(root, `${AUTH}/authenticator.ts`);
    const edited = `${await Bun.file(path).text()}// mine\n`;
    await Bun.write(path, edited);
    const result = await run('g', 'sign-in', '--oidc', 'corp-sso');
    expect(result.codes).toEqual(['X_GENERATE_CONFLICT']);
    expect(await Bun.file(path).text()).toBe(edited);
    expect(await exists(`${AUTH}/dev-actor.ts`)).toBe(true);
  }, 60_000);
});

describe('the spelling', () => {
  test.each([
    [['g', 'sign-in']],
    [['g', 'sign-in', '--password', '--oidc', 'corp']],
    [['g', 'sign-in', 'mine', '--password']],
    [['g', 'sign-in', '--oidc', 'github']],
    [['g', 'sign-in', '--oidc', 'Corp SSO']],
    [['g', 'route', 'about', '--password']],
  ])('%j is refused before anything is written', async (argv) => {
    const result = await run(...argv);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(['X_CLI_BAD_FLAG']);
    expect(await exists(`${AUTH}/sign-in/page.tsx`)).toBe(false);
    expect(await exists('apps/web/app/about/page.tsx')).toBe(false);
  });
});

describe('signInConfigEdit', () => {
  const SOURCE = `export const envSchema = {
  PORT: { type: 'port', default: 3000 },
} satisfies EnvSchema;

export const config = defineConfig({
  name: 'probe',
  cache: {},
});
`;

  test('adds the sign-in path and each missing key, once', () => {
    const keys = [{ key: 'X_ISSUER', type: 'url' as const, description: 'The issuer.' }];
    const first = signInConfigEdit(SOURCE, '/auth/sign-in', keys);
    expect(first.findings).toEqual([]);
    expect(first.contents).toContain("  name: 'probe',\n");
    expect(first.contents).toContain("auth: { signInPath: '/auth/sign-in' },\n  cache: {},");
    expect(first.contents).toContain("  X_ISSUER: {\n    type: 'url',");
    expect(signInConfigEdit(first.contents, '/auth/sign-in', keys).contents).toBe(first.contents);
  });

  test('a config reshaped past the anchors is a finding naming the lines, not a guess', () => {
    const edit = signInConfigEdit('export const config = {};\n', '/auth/sign-in', [
      { key: 'X_ISSUER', description: 'The issuer.' },
    ]);
    expect(edit.contents).toBe('export const config = {};\n');
    expect(edit.findings.map((finding) => finding.fix)).toEqual([
      "auth: { signInPath: '/auth/sign-in' },   # paste into defineConfig({ … }) in app.config.ts",
      "export const envSchema = { X_ISSUER: { type: 'string', required: false } }   # paste into the envSchema object in app.config.ts",
    ]);
  });
});
