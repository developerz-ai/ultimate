// `x clean` end to end through `cleanCommand.run`: every test leftover the framework knows of, on
// demand (#738) — `--dry-run` names them and removes nothing; the developer's own state stays.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no existence check for a directory and no recursive remove.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { cleanCommand } from './cmd-clean';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import type { JsonValue } from './output';
import { parseArgs } from './parse';
import { TEST_COMPOSE_PATH } from './templates/scaffold-test-services';
import { psLine } from './verify-services-fixture';
import { SERVICES_LIST, SERVICES_STOP, STACKS_LIST } from './verify-services-stack';

const scratch = mkdtempSync(join(tmpdir(), 'x-cmd-clean-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runner = async (command: readonly string[]): Promise<ExecResult> => ({
  command,
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (argv: readonly string[], cwd: string): CommandContext =>
  ({
    args: parseArgs([...argv], [cleanCommand.spec]),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  }) as CommandContext;

function put(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

function app(name: string): string {
  const root = join(scratch, name);
  put(join(root, 'app.config.ts'));
  put(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'));
  put(join(root, '.x', 'test-db', 'pglite-bbbbbbbbbbbbbbbb.tar'));
  put(join(root, '.x', 'cache', 'sass', 'entry.json'));
  put(join(root, '.x', 'pgdata', 'PG_VERSION'));
  put(join(root, '.x', 'storage', 'upload.bin'));
  put(join(root, 'apps', 'web', 'app', '.x', 'cache', 'sass', 'entry.json'));
  return root;
}

const data = (value: JsonValue | undefined): Record<string, JsonValue> =>
  (value ?? {}) as Record<string, JsonValue>;

describe('x clean', () => {
  test('removes the templates, the cache and the stray .x; the dev database and storage stay', async () => {
    const root = app('clean');
    // From a source folder: the app root is found, as for every `x` command.
    const result = await cleanCommand.run(context(['clean'], join(root, 'apps', 'web')));
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'))).toBe(false);
    expect(existsSync(join(root, '.x', 'cache'))).toBe(false);
    expect(existsSync(join(root, 'apps', 'web', 'app', '.x'))).toBe(false);
    expect(existsSync(join(root, '.x', 'pgdata', 'PG_VERSION'))).toBe(true);
    expect(existsSync(join(root, '.x', 'storage', 'upload.bin'))).toBe(true);
    expect(data(result.data)['dryRun']).toBe(false);
    expect((data(result.data)['paths'] as JsonValue[]).length).toBe(4);
  });

  test('--dry-run names the same paths and removes nothing', async () => {
    const root = app('dry');
    const result = await cleanCommand.run(context(['clean', '--dry-run'], root));
    expect(result.ok).toBe(true);
    expect(data(result.data)['dryRun']).toBe(true);
    expect((data(result.data)['paths'] as JsonValue[]).length).toBe(4);
    expect(existsSync(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'))).toBe(true);
    expect(existsSync(join(root, 'apps', 'web', 'app', '.x'))).toBe(true);
  });

  test('a clean app is a green no-op', async () => {
    const root = join(scratch, 'empty');
    put(join(root, 'app.config.ts'));
    const result = await cleanCommand.run(context(['clean'], root));
    expect(result.ok).toBe(true);
    expect(data(result.data)['paths']).toEqual([]);
  });
});

describe('x clean --services', () => {
  /** An app with a test stack, over a fake docker that records what it was told. */
  function stacked(
    name: string,
    answers: { ps?: string; ls?: string; stop?: number; psCode?: number },
  ) {
    const root = app(name);
    put(join(root, TEST_COMPOSE_PATH));
    const calls: string[] = [];
    const docker: CommandContext['runner'] = async (command) => {
      const line = command.join(' ');
      calls.push(line);
      const reply = (stdout: string, code = 0): ExecResult => ({
        command,
        ok: code === 0,
        code,
        stdout,
        stderr: code === 0 ? '' : 'docker said no',
        durationMs: 0,
      });
      if (line === SERVICES_LIST.join(' ')) return reply(answers.ps ?? '', answers.psCode ?? 0);
      if (line === STACKS_LIST.join(' ')) return reply(answers.ls ?? '[]');
      if (line === SERVICES_STOP.join(' ')) return reply('', answers.stop ?? 0);
      return reply('');
    };
    return {
      root,
      calls,
      ctx: (argv: readonly string[]) => ({ ...context(argv, root), runner: docker }),
    };
  }

  const services = (value: JsonValue | undefined) => data(data(value)['services']);

  test('without the flag docker is never asked', async () => {
    const { calls, ctx } = stacked('untouched', {});
    await cleanCommand.run(ctx(['clean']));
    expect(calls).toEqual([]);
  });

  test("stops this checkout's stack and says so", async () => {
    const root = join(scratch, 'stops');
    const { calls, ctx } = stacked('stops', { ps: psLine('shop-test', 'postgres', root) });
    const result = await cleanCommand.run(ctx(['clean', '--services']));
    expect(result.ok).toBe(true);
    expect(services(result.data)).toMatchObject({ project: 'shop-test', action: 'stopped' });
    expect(calls).toContain(SERVICES_STOP.join(' '));
  });

  test('--dry-run names the stack and stops nothing', async () => {
    const root = join(scratch, 'dry-stack');
    const { calls, ctx } = stacked('dry-stack', { ps: psLine('shop-test', 'redis', root) });
    const result = await cleanCommand.run(ctx(['clean', '--services', '--dry-run']));
    expect(services(result.data)).toMatchObject({ project: 'shop-test', action: 'would-stop' });
    expect(calls).not.toContain(SERVICES_STOP.join(' '));
  });

  test('a stack a live sibling started is kept, with the line that would stop it', async () => {
    const sibling = app('sibling');
    const { calls, ctx } = stacked('kept', { ps: psLine('shop-test', 'redis', sibling) });
    const result = await cleanCommand.run(ctx(['clean', '--services']));
    expect(result.ok).toBe(true);
    expect(services(result.data)).toMatchObject({ action: 'kept', owner: sibling });
    expect(result.lines?.join('\n')).toContain('docker compose -p shop-test down');
    expect(calls).not.toContain(SERVICES_STOP.join(' '));
  });

  test("other apps' stacks are listed, flagged when their checkout is gone, and left alone", async () => {
    const other = app('other-app');
    const ls = JSON.stringify([
      { Name: 'a-test', Status: 'running(4)', ConfigFiles: join(other, TEST_COMPOSE_PATH) },
      { Name: 'b-test', Status: 'running(1)', ConfigFiles: `/gone/${TEST_COMPOSE_PATH}` },
      { Name: 'prod', Status: 'running(9)', ConfigFiles: '/srv/prod/compose.yml' },
      // This checkout's own, stopped: it is not an "other".
      { Name: 'own', Status: 'exited(1)', ConfigFiles: join(scratch, 'lister', TEST_COMPOSE_PATH) },
    ]);
    const { calls, ctx } = stacked('lister', { ls });
    const result = await cleanCommand.run(ctx(['clean', '--services', '--dry-run']));
    expect(services(result.data)['others']).toEqual([
      { project: 'a-test', status: 'running(4)', root: other, gone: false },
      { project: 'b-test', status: 'running(1)', root: '/gone', gone: true },
    ]);
    expect(result.lines?.join('\n')).toContain('docker compose -p b-test down');
    expect(calls.some((line) => line.includes('-p a-test'))).toBe(false);
  });

  test('docker failing is a coded refusal, not a clean bill of health', async () => {
    const { ctx } = stacked('no-docker', { psCode: 1 });
    const result = await cleanCommand.run(ctx(['clean', '--services']));
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_TEST_SERVICES_UNAVAILABLE');
  });

  test('a stop docker refuses is a coded refusal', async () => {
    const root = join(scratch, 'stuck');
    const { ctx } = stacked('stuck', { ps: psLine('shop-test', 'redis', root), stop: 1 });
    const result = await cleanCommand.run(ctx(['clean', '--services']));
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain('docker said no');
  });

  test('an app with no test stack has nothing to stop', async () => {
    const root = app('stackless');
    const result = await cleanCommand.run(context(['clean', '--services'], root));
    expect(result.ok).toBe(true);
    expect(services(result.data)).toMatchObject({ action: 'none' });
  });
});
