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
import { envCommand } from './cmd-env';
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
    bunVersion: '1.3.0',
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
    await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
    await expect(envCommand.run(context(['env', 'example'], dir))).rejects.toBeUltimateError(
      'X_CONFIG_INVALID',
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
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = dsn;
    try {
      const result = await envCommand.run(context(['env', 'check'], root));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).not.toContain('hunter2');
      expect(record(record(result.data)['values'] as JsonValue)['RETRIES']).toBe(3);
    } finally {
      if (previous === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previous;
    }
  });
});
