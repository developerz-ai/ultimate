// `x mcp lock <name>`'s refusals, before any remote is dialled: no name, and a name no
// `mcpTools({ name })` in the app declares — which lists what IS declared, so the fix is a pick.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { mcpLock } from './cmd-mcp-lock';
import { mcpSpec } from './cmd-mcp-spec';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-mcp-lock-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');

const noProcess: Runner = () =>
  Promise.reject(new Error('x mcp lock spawned a process; it only reads the app and a remote'));

const ctxOf = (...argv: string[]): CommandContext => ({
  args: parseArgs(['mcp', 'lock', ...argv], [mcpSpec]),
  cwd: root,
  runner: noProcess,
  env: {},
  bunVersion: Bun.version,
});

const refusal = (ctx: CommandContext) =>
  mcpLock(ctx, root).then(
    () => expect.unreachable('x mcp lock answered instead of refusing'),
    (error: unknown) =>
      isUltimateError(error)
        ? { code: error.code, cause: error.cause }
        : { code: `not coded: ${String(error)}`, cause: '' },
  );

describe('x mcp lock', () => {
  test('no name is refused, naming the positional', async () => {
    const got = await refusal(ctxOf());
    expect(got.code).toBe('X_CLI_BAD_FLAG');
    expect(got.cause).toContain('<name>');
  });

  test('a name nothing declares is X_MCP_REMOTE_TOOL_CHANGED listing the declared ones', async () => {
    const got = await refusal(ctxOf('github'));
    expect(got.code).toBe('X_MCP_REMOTE_TOOL_CHANGED');
    expect(got.cause).toContain('no mcpTools({ name: github }) is declared (declared: none)');
    expect(await Bun.file(join(root, 'tools.lock.json')).exists()).toBe(false);
  });
});
