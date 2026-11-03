// `x deploy --method compose` refuses before its first step when `.env.production` is absent or
// leaves a `${VAR:?}` empty, and a failed step's finding carries the container's own last line —
// `role "migrate" step exited 1` alone was where a stranger's first deploy stopped (as run
// 2026-11-02).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and the fixtures are written synchronously.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { deployCommand } from './cmd-deploy';
import { lastLine, roleLastLogLine } from './cmd-deploy-preflight';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { names } from './templates/naming';
import { composeProdFile } from './templates/scaffold-container-compose';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function appRoot(envFile?: string, envSchema = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-preflight-'));
  madeDirs.push(dir);
  writeFileSync(
    join(dir, 'app.config.ts'),
    `${envSchema}export const config = { name: 'shop' };\n`,
  );
  mkdirSync(join(dir, 'docker'));
  writeFileSync(join(dir, 'docker', 'docker-compose.prod.yml'), composeProdFile(names('shop')));
  if (envFile !== undefined) writeFileSync(join(dir, '.env.production'), envFile);
  return dir;
}

const result = (command: readonly string[], code: number, stderr = ''): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout: '',
  stderr,
  durationMs: 1,
});

function recording(answer: (command: readonly string[]) => ExecResult) {
  const ran: string[][] = [];
  const context = (argv: string[], cwd: string, env = {}): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: async (command) => {
      ran.push([...command]);
      return answer(command);
    },
    env,
    bunVersion: REQUIRED_BUN,
  });
  return { ran, context };
}

const COMPLETE = 'POSTGRES_PASSWORD=p\nAPP_URL=http://localhost:3000\nSYNC_URL=ws://x/_x/sync\n';

describe('unit · x deploy reads .env.production before its first step', () => {
  test('no file: X_DEPLOY_ENV_MISSING, and no step runs', async () => {
    const { ran, context } = recording((command) => result(command, 0));
    const out = await deployCommand.run(context(['deploy'], appRoot()));
    expect(out.ok).toBe(false);
    expect(out.findings?.[0]?.code).toBe('X_DEPLOY_ENV_MISSING');
    expect(out.findings?.[0]?.fix).toBe('x env init --production --json');
    expect(ran).toEqual([]);
  });

  test('a required variable the file leaves empty is named, and no step runs', async () => {
    const { ran, context } = recording((command) => result(command, 0));
    const out = await deployCommand.run(
      context(['deploy'], appRoot('POSTGRES_PASSWORD=p\nAPP_URL=\n')),
    );
    expect(out.findings?.[0]?.code).toBe('X_DEPLOY_ENV_MISSING');
    expect(out.findings?.[0]?.cause).toContain('leaves SYNC_URL, APP_URL unset or empty');
    expect(ran).toEqual([]);
  });

  // `x env init --production` writes a required key it cannot derive as `KEY=`: the compose file
  // parses, and every role then refuses at boot (X_ENV_MISSING) and crash-loops.
  test('a key the app declares required, left empty, is named, and no step runs', async () => {
    const { ran, context } = recording((command) => result(command, 0));
    const schema =
      "export const envSchema = { STRIPE_KEY: { type: 'string' }, PORT: { type: 'port', default: 3000 }, NATS_URL: { type: 'url', required: false } };\n";
    const out = await deployCommand.run(
      context(['deploy'], appRoot(`${COMPLETE}STRIPE_KEY=\n`, schema)),
    );
    expect(out.findings?.[0]?.code).toBe('X_DEPLOY_ENV_MISSING');
    expect(out.findings?.[0]?.cause).toContain('leaves STRIPE_KEY unset or empty');
    expect(out.findings?.[0]?.cause).not.toContain('PORT');
    expect(ran).toEqual([]);
  });

  test('a value set in the shell counts: compose reads it there first', async () => {
    const { ran, context } = recording((command) => result(command, 0));
    const out = await deployCommand.run(
      context(['deploy'], appRoot('POSTGRES_PASSWORD=p\n'), {
        APP_URL: 'http://a:3000',
        SYNC_URL: 'ws://a:3001/_x/sync',
      }),
    );
    expect(out.ok).toBe(true);
    expect(ran.length).toBeGreaterThan(0);
  });

  test('a dry run reads nothing and still prints the plan', async () => {
    const { context } = recording((command) => result(command, 0));
    const out = await deployCommand.run(context(['deploy', '--dry-run'], appRoot()));
    expect(out.ok).toBe(true);
  });
});

describe('unit · a failed compose step carries the last line its container printed', () => {
  test('a one-shot: the step output is the container output', async () => {
    const { context } = recording((command) =>
      command.at(-1) === 'migrate'
        ? result(command, 1, 'booting\nX_CONFIG_INVALID: NATS_URL set under transport memory\n')
        : result(command, 0),
    );
    const out = await deployCommand.run(context(['deploy'], appRoot(COMPLETE)));
    expect(out.findings?.[0]?.cause).toBe(
      'role "migrate" step exited 1: X_CONFIG_INVALID: NATS_URL set under transport memory',
    );
  });

  test('a serving role: its compose log is read for the line', async () => {
    const { ran, context } = recording((command) => {
      if (command.includes('logs')) {
        return { ...result(command, 0), stdout: "X_STORAGE_UNWRITABLE EACCES mkdir '/app/.x'\n" };
      }
      return command.at(-1) === 'web' ? result(command, 1) : result(command, 0);
    });
    const out = await deployCommand.run(context(['deploy'], appRoot(COMPLETE)));
    expect(out.findings?.[0]?.cause).toBe(
      `role "web" step exited 1: X_STORAGE_UNWRITABLE EACCES mkdir '/app/.x'`,
    );
    expect(ran.at(-1)).toContain('logs');
  });

  test('the rendered refusal wins over the stack and Bun trailer printed after it', () => {
    const log = [
      "UltimateError: X_STORAGE_UNWRITABLE: storage unwritable — EACCES, mkdir '/app/.x/storage'",
      '       code: "X_STORAGE_UNWRITABLE"',
      '      at startStorage (/app/runtime-services.ts:241:11)',
      '',
      'Bun v1.4.4 (Linux x64)',
    ].join('\n');
    expect(lastLine({ stdout: log, stderr: '' })).toStartWith(
      'UltimateError: X_STORAGE_UNWRITABLE:',
    );
    expect(lastLine({ stdout: 'boom\n\nBun v1.4.4 (Linux x64)\n', stderr: '' })).toBe('boom');
  });

  test('stderr wins over stdout, and blank output reads as nothing', () => {
    expect(lastLine({ stdout: 'out\n', stderr: 'err\n\n' })).toBe('err');
    expect(lastLine({ stdout: 'out\n', stderr: '  \n' })).toBe('out');
    expect(lastLine({ stdout: '', stderr: '' })).toBe('');
  });

  test('a log read that throws leaves the finding as it was', async () => {
    const line = await roleLastLogLine({
      base: ['docker', 'compose'],
      role: 'web',
      // Input, not a verdict: the spawn failure `exec` reports for a missing binary.
      runner: () => Promise.reject(new TypeError('Executable not found in $PATH')),
      options: { cwd: '/' },
    });
    expect(line).toBe('');
  });
});
