// `x env`'s two subcommands end to end through `envCommand.run`. The write half has to be
// idempotent — the gate's `fix:` line is `x env example`, and a fix an agent runs twice must not
// produce a second diff.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway app
// roots.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { EnvSchemaMissingError, envCommand } from './cmd-env';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import type { JsonValue } from './output';
import { parseArgs } from './parse';

const SCHEMA = `export const envSchema = {
  DATABASE_URL: { type: 'url', secret: true, description: 'Postgres connection URL' },
  RETRIES: { type: 'integer', default: 3, required: false, description: 'Upstream retry budget' },
};
export const config = { name: 'fixture' };
`;

let base = '';

const runner = async (command: readonly string[]): Promise<ExecResult> => ({
  // Echoed back, as `exec()` does: `ExecResult.command` is what a failure names, so a fake that
  // invents one would report a command nobody ran.
  command,
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (argv: readonly string[], cwd: string, env: Record<string, string> = {}) => {
  const parsed = parseArgs([...argv], [envCommand.spec]);
  return {
    args: parsed,
    cwd,
    runner,
    env,
    bunVersion: REQUIRED_BUN,
  } as CommandContext;
};

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  (value ?? {}) as Record<string, JsonValue>;

const appRoot = async (name: string): Promise<string> => {
  const dir = join(base, name);
  await Bun.write(join(dir, 'app.config.ts'), SCHEMA);
  return dir;
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-cmd-env-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('unit · x env example', () => {
  test('it writes the projection, and running it again writes nothing', async () => {
    const root = await appRoot('write');
    const first = await envCommand.run(context(['env', 'example'], root));
    expect(first.ok).toBe(true);
    expect(record(first.data)['written']).toBe(true);
    const contents = await Bun.file(join(root, '.env.example')).text();
    expect(contents).toContain('DATABASE_URL=');
    expect(contents).toContain('RETRIES=3');

    const second = await envCommand.run(context(['env', 'example'], root));
    expect(record(second.data)['written']).toBe(false);
    expect(await Bun.file(join(root, '.env.example')).text()).toBe(contents);
  });

  test('an app that declares no environment is refused, never written empty', async () => {
    const dir = join(base, 'schemaless');
    await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
    await expect(envCommand.run(context(['env', 'example'], dir))).rejects.toBeUltimateError(
      'X_CONFIG_INVALID',
    );
    await expect(envCommand.run(context(['env', 'example'], dir))).rejects.toBeInstanceOf(
      EnvSchemaMissingError,
    );
  });
});

describe('unit · x env check', () => {
  test('a missing declared key is a finding with the key in it, and a non-zero exit', async () => {
    const root = await appRoot('check-missing');
    const result = await envCommand.run(context(['env', 'check'], root, {}));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.findings?.[0]?.code).toBe('X_ENV_MISSING');
    expect(result.findings?.[0]?.cause).toContain('DATABASE_URL');
  });

  // `checkEnv().values` holds the REAL value because `defineEnv()` has to return it. Anything that
  // prints goes through `maskedEnvValues` first, and `--json` is the loudest printer there is.
  // Masking follows the DECLARATION (`secret: true`), never the key's name — which is the whole
  // reason `x env check` prints this and not `report.values`.
  test('a key declared secret is never printed back, in the terminal or in --json', async () => {
    const root = await appRoot('check-mask');
    const dsn = 'postgres://user:hunter2@db.internal/app';
    const result = await envCommand.run(
      context(['env', 'check'], root, { DATABASE_URL: dsn, ULTIMATE_ENV: 'development' }),
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('hunter2');
    expect(record(record(result.data)['values'] as JsonValue)['RETRIES']).toBe(3);
  });

  // One table for the whole report: `checkEnv` read `process.env` while the command was handed
  // `ctx.env`, so the app's keys and the framework's below could be judged against two processes.
  test('the declared keys are read from the environment the command was handed', async () => {
    const root = await appRoot('check-ctx');
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgres://ambient/app';
    try {
      const env = { ULTIMATE_ENV: 'development' };
      const result = await envCommand.run(context(['env', 'check'], root, env));
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_ENV_MISSING']);
    } finally {
      if (previous === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previous;
    }
  });

  // #679: the framework's own deploy-required keys, checked where the boot would refuse them —
  // outside development/test — and silent in development, where the shipped keys are the design.
  test('a deployed environment without the framework secrets is refused, naming each', async () => {
    const root = await appRoot('check-framework');
    const env = { DATABASE_URL: 'postgres://db/app', ULTIMATE_ENV: 'production' };
    const result = await envCommand.run(context(['env', 'check'], root, env));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
    expect(result.findings?.[0]?.fix).toBe(
      'export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"',
    );
  });

  test('staging owes them too: the boot refuses outside development/test, not only production', async () => {
    const root = await appRoot('check-staging');
    const env = {
      DATABASE_URL: 'postgres://db/app',
      ULTIMATE_ENV: 'staging',
      ULTIMATE_CURSOR_SECRET: 'c'.repeat(64),
      S3_ENDPOINT: 'https://s3.example.com',
    };
    const result = await envCommand.run(context(['env', 'check'], root, env));
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // The boot FAILS CLOSED: no ULTIMATE_ENV and no NODE_ENV is production there, so it is here —
  // otherwise this answered green for exactly the process the boot refuses (#679 review).
  test('an environment that names none is checked as the boot reads it: deployed', async () => {
    const root = await appRoot('check-unnamed');
    const result = await envCommand.run(
      context(['env', 'check'], root, { DATABASE_URL: 'postgres://db/app' }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
  });

  test('development owes no framework secret', async () => {
    const root = await appRoot('check-dev');
    const env = { DATABASE_URL: 'postgres://db/app', ULTIMATE_ENV: 'development' };
    const result = await envCommand.run(context(['env', 'check'], root, env));
    expect(result.ok).toBe(true);
  });
});
