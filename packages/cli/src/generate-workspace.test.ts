// `x g app <name>` / `x g package <name>`: one more workspace in a scaffolded monorepo, refused under
// a name the other workspace kind already holds — and `--app`, which lands an app-local generator
// in a workspace other than `apps/web`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and Bun.write take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { GENERATORS, generate, generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import type { ThrownShape } from './thrown-by-fixture';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

/** A scaffolded repo's shape: the root manifest names the scope every workspace shares. */
async function repo(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-generate-workspace-'));
  const files: Record<string, string> = {
    'app.config.ts': "export const config = { name: 'acme' };\n",
    'package.json': JSON.stringify({ name: '@acme/root', workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
    ...extra,
  };
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

const run = (argv: readonly string[], cwd: string) =>
  generateCommand.run({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
    env: {},
    bunVersion: REQUIRED_BUN,
  } satisfies CommandContext);

const thrown = async (argv: readonly string[], cwd: string): Promise<ThrownShape> =>
  (await run(argv, cwd).then(
    () => expect.unreachable('expected a refusal'),
    (error: unknown) => error,
  )) as ThrownShape;

describe('unit · x g app / x g package', () => {
  test('both are generators, planned in the repo scope', () => {
    expect(GENERATORS).toContain('app');
    expect(GENERATORS).toContain('package');
    const app = generate({ kind: 'app', name: 'admin', scope: 'acme' });
    expect(app.map((file) => file.path)).toEqual([
      'apps/admin/package.json',
      'apps/admin/tsconfig.json',
    ]);
    expect(app[0]?.contents).toContain('"name": "@acme/admin"');
    const pkg = generate({ kind: 'package', name: 'domain', scope: 'acme' });
    expect(pkg.map((file) => file.path)).toContain('packages/domain/src/index.ts');
    expect(pkg.find((file) => file.path === 'packages/domain/package.json')?.contents).toContain(
      '"name": "@acme/domain"',
    );
  });

  test('x g app writes the workspace and names install, then the changed-files gate, next', async () => {
    const dir = await repo();
    const result = await run(['g', 'app', 'admin'], dir);
    expect(result.ok).toBe(true);
    expect(
      ((await Bun.file(join(dir, 'apps/admin/package.json')).json()) as { name: string }).name,
    ).toBe('@acme/admin');
    expect((result.data as { next?: readonly string[] }).next).toEqual([
      'bun install',
      'bunx x verify --changed --dirty',
    ]);
  });

  test('x g package reads the scope from the root manifest, scoped or bare', async () => {
    const dir = await repo({ 'package.json': JSON.stringify({ name: 'acme' }) });
    expect((await run(['g', 'package', 'domain'], dir)).ok).toBe(true);
    const written = (await Bun.file(join(dir, 'packages/domain/package.json')).json()) as {
      name: string;
    };
    expect(written.name).toBe('@acme/domain');
  });

  test('a name the other workspace kind holds is refused: both would be @<scope>/<name>', async () => {
    const dir = await repo({
      'packages/domain/package.json': JSON.stringify({ name: '@acme/domain' }),
    });
    const app = await thrown(['g', 'app', 'domain'], dir);
    expect(app.code).toBe('X_WORKSPACE_NAME_TAKEN');
    expect(app.fix).toBe('x g app domain-app');
    const pkg = await thrown(['g', 'package', 'web'], dir);
    expect(pkg.code).toBe('X_WORKSPACE_NAME_TAKEN');
    expect(await Bun.file(join(dir, 'apps/domain/package.json')).exists()).toBe(false);
  });

  // A workspace is not a slice: every slice flag would be accepted and change nothing.
  test('a slice flag is refused, naming the run without it, and nothing is written', async () => {
    const dir = await repo();
    for (const [kind, flag, value] of [
      ['app', 'feature', 'billing'],
      ['package', 'surface', 'site'],
      ['app', 'live', undefined],
      ['package', 'admin', undefined],
      ['app', 'locales', 'es'],
      ['package', 'at', 'apps/web/app'],
      ['app', 'app', 'admin'],
      ['package', 'permission', 'post:read'],
    ] as const) {
      const argv = ['g', kind, 'domain', `--${flag}`, ...(value === undefined ? [] : [value])];
      const failure = await thrown(argv, dir);
      expect([failure.code, failure.fix]).toEqual(['X_CLI_BAD_FLAG', `x g ${kind} domain`]);
      expect(failure.cause).toContain(`--${flag}`);
    }
    expect(await Bun.file(join(dir, 'apps/domain/package.json')).exists()).toBe(false);
    expect(await Bun.file(join(dir, 'packages/domain/package.json')).exists()).toBe(false);
    // Its own two flags, and a slice flag at its default, are still the plain run.
    expect((await run(['g', 'app', 'domain', '--surface', 'app', '--dry-run'], dir)).ok).toBe(true);
  });

  test('a dry run plans the files and writes nothing', async () => {
    const dir = await repo();
    const result = await run(['g', 'package', 'domain', '--dry-run'], dir);
    expect((result.data as { files: readonly string[] }).files).toContain(
      'packages/domain/src/index.ts',
    );
    expect(await Bun.file(join(dir, 'packages/domain/package.json')).exists()).toBe(false);
  });
});

describe('unit · --app', () => {
  test('an app-local generator lands under apps/<app>, and web is the default', () => {
    const paths = (app?: string) =>
      generate({ kind: 'route', name: 'reports', ...(app === undefined ? {} : { app }) }).map(
        (file) => file.path,
      );
    expect(paths()).toContain('apps/web/app/reports/page.tsx');
    expect(paths('admin')).toContain('apps/admin/app/reports/page.tsx');
    const island = generate({ kind: 'island', name: 'glow', app: 'admin' }).map((f) => f.path);
    expect(island).toContain('apps/admin/app/glow/glow.island.tsx');
  });

  test('an app that is not there is refused, with the command that makes it', async () => {
    const dir = await repo();
    const failure = await thrown(['g', 'route', 'reports', '--app', 'admin'], dir);
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x g app admin');
  });

  test('a generator that registers in apps/web refuses another app instead of splitting a slice', async () => {
    const dir = await repo({ 'apps/admin/package.json': JSON.stringify({ name: '@acme/admin' }) });
    const failure = await thrown(['g', 'job', 'send-digest', '--app', 'admin'], dir);
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x g job send-digest');
    expect((await run(['g', 'route', 'reports', '--app', 'admin'], dir)).ok).toBe(true);
    expect(await Bun.file(join(dir, 'apps/admin/app/reports/page.tsx')).exists()).toBe(true);
  });
});
