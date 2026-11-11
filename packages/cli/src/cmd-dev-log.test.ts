// `x dev` writes `.x/dev.log` on every run, unasked: the dev MCP server's `logs.tail` reads that
// file, and before this the only way to get one was a shell redirect nobody knew to type.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { logger } from '@ultimat3/core';
import { devCommand } from './cmd-dev';
import { devSpec } from './cmd-dev-spec';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noRunner: Runner = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

test('x dev --once tees the process log into .x/dev.log, and stops teeing when it stops', async () => {
  // Inside this package, so the fixture's `@ultimat3/*` imports resolve.
  const root = mkdtempSync(join(import.meta.dir, '..', '.dev-log-cmd-fixture-'));
  dirs.push(root);
  await Bun.write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dev-log', version: '1.0.0' }),
  );
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'dev-log' };\n");
  const result = await devCommand.run({
    args: parseArgs(['dev', '--once', '--port', '0', '--json'], [devSpec]),
    cwd: root,
    env: { ULTIMATE_ENV: 'development' },
    runner: noRunner,
    bunVersion: Bun.version,
  });
  logger.info('dev.log.after-stop');
  const log = await Bun.file(join(root, '.x', 'dev.log')).text();
  expect(result.command).toBe('dev');
  expect(log.split('\n').filter((line) => line.startsWith('{')).length).toBeGreaterThan(0);
  expect(log).not.toContain('dev.log.after-stop');
}, 120_000);
