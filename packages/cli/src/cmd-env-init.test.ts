// `x env init --production` against the files `x new` writes: every `${VAR:?}` the scaffold's
// compose file refuses to parse without gets a value, the database URL names the compose `db`,
// the secrets are fresh and unprinted, and a second run refuses rather than re-minting them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the app roots.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { composeRequiredVars } from './cmd-deploy-compose';
import { envCommand } from './cmd-env';
import { initProductionEnv, randomSecret } from './cmd-env-init';
import type { CommandContext } from './command';
import type { JsonValue } from './output';
import { parseArgs } from './parse';
import { parseDotenv } from './root-env';
import { names } from './templates/naming';
import { composeProdFile } from './templates/scaffold-container-compose';
import { envSchemaSource } from './templates/scaffold-env';

let base = '';
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-env-init-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const context = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs([...argv], [envCommand.spec]),
  cwd,
  runner: async (command) => expect.unreachable(`x env init spawned ${command.join(' ')}`),
  env: {},
  bunVersion: REQUIRED_BUN,
});

/** A scaffold's two inputs: its `app.config.ts` env declaration and its production compose file. */
async function scaffold(name: string, gitignore = '.env\n'): Promise<string> {
  const dir = join(base, name);
  await Bun.write(
    join(dir, 'app.config.ts'),
    `${envSchemaSource()}\nexport const config = { name: 'shop' };\n`,
  );
  await Bun.write(join(dir, 'docker', 'docker-compose.prod.yml'), composeProdFile(names('shop')));
  await Bun.write(join(dir, '.gitignore'), gitignore);
  return dir;
}

const data = (value: JsonValue | undefined) => (value ?? {}) as Record<string, JsonValue>;

describe('unit · x env init --production', () => {
  test('every variable the scaffold compose file requires (:?) is written, non-empty', async () => {
    const root = await scaffold('required');
    const result = await envCommand.run(context(['env', 'init', '--production'], root));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    const values = parseDotenv(await Bun.file(join(root, '.env.production')).text());
    const required = composeRequiredVars(composeProdFile(names('shop')));
    expect(required).toEqual(['POSTGRES_PASSWORD', 'SYNC_URL', 'APP_URL']);
    for (const key of required) expect([key, (values.get(key) ?? '') !== '']).toEqual([key, true]);
    expect(data(result.data)['unfilled']).toEqual([]);
  });

  test('DATABASE_URL names the compose db with the password the db is started with', async () => {
    const root = await scaffold('database');
    await envCommand.run(context(['env', 'init', '--production'], root));
    const values = parseDotenv(await Bun.file(join(root, '.env.production')).text());
    expect(values.get('DATABASE_URL')).toBe(
      `postgres://postgres:${values.get('POSTGRES_PASSWORD')}@db:5432/shop`,
    );
    expect(values.get('ULTIMATE_ENV')).toBe('production');
    expect(values.get('IMAGE')).toBe('ultimate-app:dev');
  });

  test('each secret is fresh, and none of them reaches the report', async () => {
    const root = await scaffold('secrets');
    const result = await envCommand.run(context(['env', 'init', '--production'], root));
    const values = parseDotenv(await Bun.file(join(root, '.env.production')).text());
    const secrets = ['SESSION_SECRET', 'ULTIMATE_CURSOR_SECRET', 'STORAGE_SIGNING_SECRET'].map(
      (key) => values.get(key) ?? '',
    );
    for (const value of secrets) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(secrets).size).toBe(secrets.length);
    const report = JSON.stringify(result);
    for (const value of secrets) expect(report).not.toContain(value);
    expect((await Bun.file(join(root, '.env.production')).stat()).mode & 0o777).toBe(0o600);
  });

  test('the file is gitignored once, before a commit could pick it up', async () => {
    const root = await scaffold('ignored', 'node_modules\n.env');
    const result = await envCommand.run(context(['env', 'init', '--production'], root));
    expect(data(result.data)['gitignored']).toBe(true);
    expect(await Bun.file(join(root, '.gitignore')).text()).toBe(
      'node_modules\n.env\n.env.production\n',
    );
  });

  test('a second run refuses with X_ENV_FILE_EXISTS and leaves the file as it was', async () => {
    const root = await scaffold('twice');
    await envCommand.run(context(['env', 'init', '--production'], root));
    const before = await Bun.file(join(root, '.env.production')).text();
    const thrown = await envCommand.run(context(['env', 'init', '--production'], root)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_ENV_FILE_EXISTS');
    expect(await Bun.file(join(root, '.env.production')).text()).toBe(before);
  });

  test('without --production it refuses and writes nothing', async () => {
    const root = await scaffold('unflagged');
    const thrown = await envCommand.run(context(['env', 'init'], root)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_CLI_BAD_FLAG');
    expect(await Bun.file(join(root, '.env.production')).exists()).toBe(false);
  });

  test('a required key nothing can know is written empty and named, and the run is red', async () => {
    const root = join(base, 'custom');
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const envSchema = { STRIPE_KEY: { type: 'string', description: 'the Stripe key' } };\nexport const config = { name: 'custom' };\n",
    );
    await Bun.write(
      join(root, 'docker', 'docker-compose.prod.yml'),
      `services:\n  web: { environment: ["X=\${MAIL_HOST:?set it}"] }\n`,
    );
    const result = await initProductionEnv(context(['env', 'init', '--production'], root), () =>
      'f'.repeat(64),
    );
    expect(result.ok).toBe(false);
    expect(data(result.data)['unfilled']).toEqual(['STRIPE_KEY', 'MAIL_HOST']);
    const text = await Bun.file(join(root, '.env.production')).text();
    expect(text).toContain('# required: the Stripe key\nSTRIPE_KEY=\n');
    // No `db` service: the database is the operator's, so no URL is invented for it.
    expect(text).not.toContain('DATABASE_URL');
  });

  test('a random secret is 32 bytes of hex', () => {
    expect(randomSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomSecret()).not.toBe(randomSecret());
  });
});
