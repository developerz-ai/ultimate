// `x mcp serve --transport stdio` as a client spawns it: fd 1 is the JSON-RPC wire and carries
// nothing else. An app module that logs while the host loads it wrote that line to stdout ahead of
// the `initialize` reply (plan 101 19b), and a strict client drops a session on a non-frame line.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and Bun.spawn take one already joined.
import { join } from 'node:path';
import { processRoot } from './process-root-fixture';

// Under `packages/cli/` so the spawned CLI resolves `@ultimat3/*` through the same tsconfig paths.
const ROOT = processRoot(join(import.meta.dir, '..', '.mcp-stdio-fixture'));
const BIN = join(import.meta.dir, 'bin.ts');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'mcp-stdio-fixture', version: '1.0.0' }),
  'app.config.ts': "export const config = { name: 'mcp-stdio-fixture' };\n",
  // Logs while `loadApp` imports it — what the reference app's authenticator does in development.
  'apps/web/api/boot-log.ts':
    "import { logger } from '@ultimat3/core';\nlogger.warn('stdio fixture loaded');\nexport const loaded = true;\n",
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cmd-mcp-stdio', version: '0' },
  },
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('x mcp serve --transport stdio keeps stdout for JSON-RPC', () => {
  test('an app log line goes to stderr; every stdout line is a frame', async () => {
    const child = Bun.spawn(
      [process.execPath, BIN, 'mcp', 'serve', '--transport', 'stdio', '--cwd', ROOT],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
        // A backstop only: the closed stdin is what ends the session.
        timeout: 100_000,
      },
    );
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    // A closed stdin ends the session, so the process exits on that event, not on a timer.
    await child.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    const frames = lines.map((line) => {
      try {
        return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc;
      } catch {
        return line;
      }
    });
    expect(frames).toEqual(['2.0']);
    expect((JSON.parse(lines[0] ?? '{}') as { id?: unknown }).id).toBe(1);
    // The line was written, and where a client shows a server's diagnostics.
    expect(stderr).toContain('stdio fixture loaded');
  }, 120_000);
});
