// `x manifest` against real apps on disk. Two invariants this file exists for: a stale
// `x.manifest.json` reports the same code `x verify` reports for it, and a partial load never
// persists — `x.manifest.json` is the compatibility contract, so a subset of the app is a lie.

// Bun ships no `Bun.*` equivalent for either: `rm` tears each fixture tree down recursively, and
// `join` builds the host-separator paths the fixtures are written to and read from.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';
import { OPENAPI_FILE } from './app-openapi';
import { manifestCommand } from './cmd-manifest';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { FlagValue } from './parse';

const WHOLE = join(import.meta.dir, '..', '.manifest-whole-fixture');
const PARTIAL = join(import.meta.dir, '..', '.manifest-partial-fixture');

const APP_CONFIG = `export const config = { name: 'fixture' };\n`;

const WHOLE_FILES: Readonly<Record<string, string>> = {
  'app.config.ts': APP_CONFIG,
  'package.json': JSON.stringify({ name: 'whole-fixture', version: '1.4.0' }),
  'apps/web/site/pricing/page.tsx': `import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  meta: () => ({ title: 'Pricing' }),
});
`,
};

// Nothing here registers a primitive: the broken module must be the ONLY difference, so a test
// that asserts "nothing was written" cannot be passing for a second reason.
const PARTIAL_FILES: Readonly<Record<string, string>> = {
  'app.config.ts': APP_CONFIG,
  'package.json': JSON.stringify({ name: 'partial-fixture', version: '0.2.0' }),
  'apps/web/app/broken.ts': `export { nope } from './does-not-exist';\n`,
};

const write = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
};

const resetRegistries = (): void => {
  resetActions();
  resetQueries();
  clearEntities();
  clearRoutes();
  resetJobs();
  resetTasks();
  clearPermissions();
  clearRoles();
  resetAppLoad();
};

const contextFor = (root: string, flags: Readonly<Record<string, FlagValue>>): CommandContext => ({
  args: {
    command: 'manifest',
    subcommand: undefined,
    positionals: [],
    flags: new Map(Object.entries(flags)),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: '1.3.0',
});

const exists = (root: string, file: string): Promise<boolean> =>
  Bun.file(join(root, file)).exists();

beforeAll(async () => {
  await write(WHOLE, WHOLE_FILES);
  await write(PARTIAL, PARTIAL_FILES);
  resetRegistries();
});

afterAll(async () => {
  await rm(WHOLE, { recursive: true, force: true });
  await rm(PARTIAL, { recursive: true, force: true });
  resetRegistries();
});

describe('unit · x manifest', () => {
  test('--check on an app that never generated one reports drift, not a second code', async () => {
    const result = await manifestCommand.run(contextFor(WHOLE, { check: true }));
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(msg('cli.manifest.stale'));
    // `x verify` reports this exact condition as X_MANIFEST_DRIFT through `assertNoDrift`;
    // X_MANIFEST_STALE is openapi.json's, which drifts on its own.
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_MANIFEST_DRIFT']);
    expect(result.findings?.[0]?.docs).toBe(ERROR_DOCS_URL);
    expect(result.findings?.[0]?.fix).toBe('x manifest');
    expect(result.findings?.[0]?.at).toBe(MANIFEST_FILENAME);
  });

  test('a whole load writes both generated files', async () => {
    const result = await manifestCommand.run(contextFor(WHOLE, {}));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain(MANIFEST_FILENAME);
    expect(await exists(WHOLE, MANIFEST_FILENAME)).toBe(true);
    expect(await exists(WHOLE, OPENAPI_FILE)).toBe(true);
  });

  test('--check on what was just written says fresh, with no findings', async () => {
    const result = await manifestCommand.run(contextFor(WHOLE, { check: true }));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.manifest.fresh'));
    expect(result.findings ?? []).toEqual([]);
  });

  test('a partial load writes neither file: a subset of the app is not the contract', async () => {
    const result = await manifestCommand.run(contextFor(PARTIAL, {}));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toEqual(['apps/web/app/broken.ts']);
    expect(await exists(PARTIAL, MANIFEST_FILENAME)).toBe(false);
    expect(await exists(PARTIAL, OPENAPI_FILE)).toBe(false);
  });

  test('the blocked run still reports the build id and the counts, so --json loses nothing', async () => {
    const result = await manifestCommand.run(contextFor(PARTIAL, {}));
    expect(result.summary).toBe(msg('cli.manifest.blocked', { count: 1 }));
    const data = result.data as { buildId?: string; counts?: { routes?: number } };
    expect(data.buildId?.length).toBeGreaterThan(0);
    expect(data.counts?.routes).toBeGreaterThanOrEqual(0);
  });
});
