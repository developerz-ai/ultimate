// `x mcp` end to end against a real app root: the catalog it prints, and the HTTP transport it
// mounts — which must refuse an unauthenticated caller before it answers anything, and answer the
// real protocol with the token the command minted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { resetAppLoad } from './app-load';
import { REQUIRED_BUN } from './app-root';
import type { McpHttpServer } from './cmd-mcp';
import { mcpCommand, startMcpHttp, stdioResult } from './cmd-mcp';
import type { CommandContext } from './command';
import { CliNotImplementedError } from './errors';
import type { Runner } from './exec';
import { createDevMcpServer } from './mcp-host';
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
  throw new CliNotImplementedError({
    feature: `a subprocess from x mcp (${command.join(' ')})`,
    fix: 'x mcp tools --json',
  });
};

const context = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: ROOT,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

interface ToolRow {
  readonly name: string;
  readonly description: string;
}

interface CatalogData {
  readonly tools: readonly ToolRow[];
  readonly scopes: readonly string[];
}

interface ServeData {
  readonly url: string;
  readonly token: string;
  readonly tools: number;
  readonly scopes: readonly string[];
}

const SCOPES = ['db:migrate', 'db:read', 'dev:logs', 'dev:read', 'dev:test'];

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

/** The refusal itself, not its rendering: `cause` is what an agent reads back the typed value in. */
async function refusalFor(argv: readonly string[]): Promise<UltimateError> {
  const thrown: unknown = await mcpCommand.run(context(argv)).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(thrown instanceof UltimateError)) {
    // `expect.unreachable`, never a bare `Error`: its `never` return narrows `thrown` for the line
    // below, and the report lands on the assertion rather than on the throw.
    expect.unreachable(`x ${argv.join(' ')} should be refused, got ${String(thrown)}`);
  }
  return thrown;
}

describe('unit · x mcp tools', () => {
  test('prints the framework catalog, not a list the CLI keeps', async () => {
    const result = await mcpCommand.run(context(['mcp', 'tools', '--json']));
    const { tools } = result.data as unknown as CatalogData;
    expect(tools).toHaveLength(13);
    expect(tools.map((tool) => tool.name)).toContain('verify.run');
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(20);
    expect(result.summary).toBe('mcp none serving 13 tools');
    // `x mcp tools` builds the catalog, which now resolves every code's fix by walking the whole
    // framework scope — real I/O over every published package's `src`. It is ~1.3s alone and the
    // headroom is what 8-way sharding eats, so the scan is the point and the timeout is what moves.
    // A literal rather than `scripts/lib/run.ts`'s constant: a published package's suite must not
    // import the host monorepo's scripts. Same reason `error-catalog.test.ts` repeats it.
  }, 30_000);

  test('--json carries every line the terminal renders, the scopes included', async () => {
    const result = await mcpCommand.run(context(['mcp', 'tools', '--json']));
    const payload = JSON.parse(renderJson(result)) as { data: CatalogData };
    const rendered = (result.lines ?? []).filter((line) => !line.startsWith('  scopes'));
    expect(payload.data.tools.map((tool) => tool.name)).toEqual(
      rendered.map((line) => line.trim().split(/\s+/)[0] ?? ''),
    );
    // The gap this closes: the scope line used to exist only in `lines`, so `--json` could not
    // reproduce what the terminal printed.
    expect(payload.data.scopes).toEqual(SCOPES);
    expect(result.lines?.at(-1)).toBe(`  scopes ${SCOPES.join(' ')}`);
    // Same catalog scan as above, so the same budget.
  }, 30_000);

  test('the server closes cleanly, so a second run is identical', async () => {
    const first = await mcpCommand.run(context(['mcp', 'tools']));
    const second = await mcpCommand.run(context(['mcp', 'tools']));
    expect(second.data).toEqual(first.data as never);
    expect(second.ok).toBe(true);
    // Two catalog builds, so the most exposed of the three. Raised with its neighbours rather than
    // after it is observed failing: they call one function, and fixing one relocates the failure to
    // whichever shard the others land in.
  }, 30_000);

  test('an unknown transport is refused before the app is loaded', async () => {
    // Awaited: an unawaited `.rejects` settles after the test body returns, so the assertion
    // could never fail the run.
    await expect(mcpCommand.run(context(['mcp', 'serve', '--transport', 'grpc']))).rejects.toThrow(
      /X_CLI_BAD_FLAG/,
    );
  });

  test('a port outside 0..65535 is refused with the working invocation', async () => {
    await expect(
      mcpCommand.run(context(['mcp', 'serve', '--transport', 'http', '--port', '70000'])),
    ).rejects.toThrow(/X_CLI_BAD_FLAG/);
  });

  // The range check alone passed every one of these, because `Number.parseInt` answers on a PREFIX:
  // `1e5` bound port 1, `0x10` bound 0 — whichever port the kernel then chose — and `9229abc` bound
  // 9229. A socket at an address the operator did not type is the one outcome `x mcp serve` must
  // not have, and its whole output is the url it claims to be reachable at.
  test('a --port that only prefix-parses is refused, never rounded into a real port', async () => {
    for (const raw of ['9229abc', '1e5', '12.9', ' 42', '0x10', '+80']) {
      const thrown = await refusalFor(['mcp', 'serve', '--transport', 'http', '--port', raw]);
      expect([raw, thrown.code]).toEqual([raw, 'X_CLI_BAD_FLAG']);
      expect([raw, thrown.cause]).toEqual([
        raw,
        `--port on "x mcp serve": expects an integer from 0 to 65535, got "${raw}"`,
      ]);
      expect([raw, thrown.fix]).toEqual([raw, 'x mcp serve --transport http --port 9229']);
    }
  });
});

describe('unit · x mcp serve --transport http', () => {
  let server: McpHttpServer;
  let data: ServeData;

  beforeAll(async () => {
    // Driven through `startMcpHttp` rather than `run` for one reason: this suite has to give the
    // socket and the host's lazy services back, and only the stop handle can.
    const host = await createDevMcpServer({ root: ROOT, env: {}, runner });
    // Port 0: the kernel picks one, so this never collides with a running `x mcp serve`.
    server = startMcpHttp(host, 0);
    data = server.result.data as unknown as ServeData;
  });

  afterAll(async () => {
    await server.stop();
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
    expect(data.scopes).toEqual(SCOPES);
    expect(server.result.summary).toBe('mcp http serving 13 tools');
  });

  test('no token is 401, and the body says how to get one', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(401);
    expect((await response.json()) as { fix: string }).toMatchObject({ code: 'X_MCP_PROTOCOL' });
  });

  test('a wrong token is 401 too — the catalog stays invisible', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
    // Same length, and a correct prefix: the two shapes a `===` short-circuit answers faster on.
    const sameLength = `${data.token.slice(0, -1)}${data.token.endsWith('a') ? 'b' : 'a'}`;
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, sameLength)).status).toBe(
      401,
    );
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, data.token.slice(0, 8))).status,
    ).toBe(401);
  });

  // A source assertion, because a timing difference is not something a test on a shared runner can
  // measure honestly. Every other secret comparison in the framework goes through core's
  // `timingSafeEqual`; this was the one exception, and an exception nothing checks comes back.
  test('the bearer token is compared with core’s timingSafeEqual, never ===', async () => {
    const source = await Bun.file(join(import.meta.dir, 'cmd-mcp.ts')).text();
    expect(source).toContain('timingSafeEqual(candidate, token)');
    expect(source).not.toMatch(/candidate\s*===\s*token/);
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

/**
 * Under `--transport stdio`, stdout is the WIRE: `serveStdio` reads JSON-RPC frames off stdin and
 * writes them to fd 1. This file's own header has always said "nothing here writes to it
 * directly", and the command's result — `✓ mcp stdio serving 13 tools`, rendered by `dispatch`
 * after the loop exits — went to fd 1 anyway, which is a malformed frame to whatever is still
 * reading. Under `--json` it is worse: a second document after the protocol traffic.
 */
describe('unit · x mcp serve --transport stdio leaves stdout to the protocol', () => {
  test('the session result is addressed to stderr, and says what it served', () => {
    const result = stdioResult(13);
    expect(result.stream).toBe('stderr');
    expect(result.summary).toBe('mcp stdio serving 13 tools');
    expect(result.data).toEqual({ transport: 'stdio', tools: 13 });
  });

  test('the http transport keeps stdout: its url and token ARE the answer', async () => {
    const host = await createDevMcpServer({ root: ROOT, env: {}, runner });
    const served = startMcpHttp(host, 0);
    try {
      expect(served.result.stream).toBeUndefined();
    } finally {
      await served.stop();
    }
  }, 30_000);
});
