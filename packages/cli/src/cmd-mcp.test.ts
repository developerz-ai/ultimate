// `x mcp` end to end against a real app root: the catalog it prints, and the HTTP transport it
// mounts — which must refuse an unauthenticated caller before it answers anything, and answer the
// real protocol with the token the command minted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetAppLoad } from './app-load';
import { mcpCommand } from './cmd-mcp';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import type { CommandResult } from './output';
import { renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

// Under `packages/cli/` so the fixture resolves `@ultimat3/*` through the same tsconfig paths the
// framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.mcp-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'mcp-fixture', version: '2.1.0' }),
  'app.config.ts': `export const config = { name: 'mcp-fixture' };\n`,
};

/** No subprocess is reachable from `x mcp tools` or the HTTP mount; a call here is the bug. */
const runner: Runner = (command) => {
  throw new Error(`no subprocess expected, got: ${command.join(' ')}`);
};

const context = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: ROOT,
  runner,
  env: {},
  bunVersion: '1.3.0',
});

interface ToolRow {
  readonly name: string;
  readonly description: string;
}

interface ServeData {
  readonly url: string;
  readonly token: string;
  readonly tools: number;
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetAppLoad();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetAppLoad();
});

describe('unit · x mcp tools', () => {
  test('prints the framework catalog, not a list the CLI keeps', async () => {
    const result = await mcpCommand.run(context(['mcp', 'tools', '--json']));
    const tools = result.data as readonly ToolRow[];
    expect(tools).toHaveLength(13);
    expect(tools.map((tool) => tool.name)).toContain('verify.run');
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(20);
    expect(result.summary).toBe('mcp none serving 13 tools');
  });

  test('--json carries the same catalog the terminal renders, plus the scopes', async () => {
    const result = await mcpCommand.run(context(['mcp', 'tools', '--json']));
    const payload = JSON.parse(renderJson(result)) as { data: readonly ToolRow[] };
    const rendered = (result.lines ?? []).filter((line) => !line.startsWith('  scopes'));
    expect(payload.data.map((tool) => tool.name)).toEqual(
      rendered.map((line) => line.trim().split(/\s+/)[0] ?? ''),
    );
    expect(result.lines?.at(-1)).toBe('  scopes db:migrate db:read dev:logs dev:read dev:test');
  });

  test('the server closes cleanly, so a second run is identical', async () => {
    const first = await mcpCommand.run(context(['mcp', 'tools']));
    const second = await mcpCommand.run(context(['mcp', 'tools']));
    expect(second.data).toEqual(first.data as never);
    expect(second.ok).toBe(true);
  });

  test('an unknown transport is refused before the app is loaded', async () => {
    expect(mcpCommand.run(context(['mcp', 'serve', '--transport', 'grpc']))).rejects.toThrow(
      /X_CLI_BAD_FLAG/,
    );
  });
});

describe('unit · x mcp serve --transport http', () => {
  let served: CommandResult;
  let data: ServeData;

  beforeAll(async () => {
    // Port 0: the kernel picks one, so this never collides with a running `x mcp serve`.
    served = await mcpCommand.run(context(['mcp', 'serve', '--transport', 'http', '--port', '0']));
    data = served.data as unknown as ServeData;
  });

  const rpc = (body: unknown, token?: string): Promise<Response> =>
    fetch(data.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  test('the minted token is reported so an agent reads it from --json', () => {
    expect(data.url).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
    expect(data.token.length).toBeGreaterThan(16);
    expect(data.tools).toBe(13);
    expect(served.summary).toBe('mcp http serving 13 tools');
  });

  test('no token is 401, and the body says how to get one', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(401);
    expect((await response.json()) as { fix: string }).toMatchObject({ code: 'X_MCP_PROTOCOL' });
  });

  test('a wrong token is 401 too — the catalog stays invisible', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
  });

  test('the minted token answers initialize', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, data.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('ultimate-dev');
  });

  test('the minted token lists all 13 tools', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, data.token);
    const body = (await response.json()) as { result: { tools: readonly ToolRow[] } };
    expect(body.result.tools).toHaveLength(13);
    expect(body.result.tools.map((tool) => tool.name)).toContain('db.query');
  });

  test('any other path is 404 — one route, nothing to probe', async () => {
    const response = await fetch(`${data.url.replace('/mcp', '')}/tools`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
