// `x logs tail`: the end of the dev log or of one role's log, the path rule the `logs.tail` MCP
// tool uses, `--role` and `--lines` refused before any file is opened, a missing log answered with
// the process that writes it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in this synchronous fixture helper.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { logsCommand, logsCommandOver } from './cmd-logs';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const appRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-logs-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
};

const ctxFor = (cwd: string, argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  // Pinned: the state directory is the app's `.x`, whatever the shell running this test says.
  env: { ULTIMATE_STATE_DIR: join(cwd, '.x') },
  bunVersion: REQUIRED_BUN,
});

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('unit · x logs tail', () => {
  test('the last --lines lines of .x/dev.log, bare form included', async () => {
    const root = appRoot();
    mkdirSync(join(root, '.x'), { recursive: true });
    writeFileSync(join(root, '.x', 'dev.log'), `${numbered(250)}\n`);
    const bare = await logsCommand.run(ctxFor(root, ['logs']));
    expect(bare.lines?.length).toBe(100);
    expect(bare.lines?.at(-1)).toBe('line 250');
    const three = await logsCommand.run(ctxFor(root, ['logs', 'tail', '--lines', '3']));
    expect(three.data).toMatchObject({
      path: join(root, '.x', 'dev.log'),
      role: null,
      lines: ['line 248', 'line 249', 'line 250'],
    });
  });

  test('--role reads .x/logs/<role>.log', async () => {
    const root = appRoot();
    mkdirSync(join(root, '.x', 'logs'), { recursive: true });
    writeFileSync(join(root, '.x', 'logs', 'worker.log'), 'job.done\n');
    const result = await logsCommand.run(ctxFor(root, ['logs', 'tail', '--role', 'worker']));
    expect(result.data).toMatchObject({ role: 'worker', lines: ['job.done'] });
  });

  test('a role that is not one, or a bad --lines, is refused before a file is opened', async () => {
    let opened = 0;
    const command = logsCommandOver(async () => {
      opened += 1;
      return undefined;
    });
    const root = appRoot();
    for (const argv of [
      ['logs', 'tail', '--role', '../../etc/passwd'],
      ['logs', 'tail', '--lines', '0'],
      ['logs', 'tail', '--lines', '4abc'],
      ['logs', 'tail', '--lines', '10001'],
    ]) {
      const failure = await command.run(ctxFor(root, argv)).catch((error: unknown) => error);
      expect(failure).toBeUltimateError('X_CLI_BAD_FLAG');
      // This command's own refusal, never the MCP tool's (`x mcp serve`) borrowed from below it.
      expect((failure as { cause: string }).cause).toContain('"x logs tail"');
    }
    expect(opened).toBe(0);
  });

  test('no log yet answers the process that writes it', async () => {
    const root = appRoot();
    const failure = await logsCommand.run(ctxFor(root, ['logs'])).catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect((failure as { fix: string }).fix).toBe('x dev');
  });
});
