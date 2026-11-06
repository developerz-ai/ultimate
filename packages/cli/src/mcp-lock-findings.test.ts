// The `manifest` step's remote-MCP half: a remote tool that changed since `tools.lock.json` is a
// finding (`X_MCP_REMOTE_TOOL_CHANGED`, the fix `x mcp lock <name>`); a server that cannot answer
// is a warning; an app with no `mcpTools()` reads nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive delete and no path-join primitive.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeclaredMcpServer, McpClient, RemoteTool } from '@ultimat3/mcp';
import { McpRemoteRefusedError, TOOLS_LOCK_FILE, writeToolsLock } from '@ultimat3/mcp';
import { mcpLockFindings } from './mcp-lock-findings';

const URL = 'https://mcp.vendor.test/mcp';
const SEARCH: RemoteTool = {
  name: 'search',
  description: 'Search the docs.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  readOnlyHint: true,
};

function serverOf(live: () => Promise<readonly RemoteTool[]>): DeclaredMcpServer {
  const client: McpClient = {
    name: 'vendor',
    url: URL,
    listTools: live,
    callTool: () => Promise.reject(new Error('not called by the check')),
    close: () => {},
  };
  return { name: 'vendor', url: URL, allow: ['search'], client };
}

const loaded = async () => ({ findings: [] });
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-lock-'));
  await Bun.write(
    join(root, TOOLS_LOCK_FILE),
    writeToolsLock(undefined, 'vendor', URL, ['search'], [SEARCH]),
  );
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('mcpLockFindings', () => {
  test('a server that still matches its lock is no finding', async () => {
    const servers = new Map([['vendor', serverOf(async () => [SEARCH])]]);
    expect(await mcpLockFindings(root, loaded, () => servers)).toEqual({
      findings: [],
      warnings: [],
    });
  });

  test('a changed input schema is X_MCP_REMOTE_TOOL_CHANGED, fixed by x mcp lock', async () => {
    const moved: RemoteTool = { ...SEARCH, inputSchema: { type: 'object', properties: {} } };
    const servers = new Map([['vendor', serverOf(async () => [moved])]]);
    const report = await mcpLockFindings(root, loaded, () => servers);
    expect(report.findings.map((finding) => finding.code)).toEqual(['X_MCP_REMOTE_TOOL_CHANGED']);
    expect(report.findings[0]?.cause).toContain('"search" changed its input schema');
    expect(report.findings[0]?.fix).toStartWith('x mcp lock vendor');
  });

  test('a server that cannot list its tools is a warning, never a finding', async () => {
    const down = new McpRemoteRefusedError({
      server: 'vendor',
      url: URL,
      reason: 'was down',
      failure: 'transport',
    });
    const servers = new Map([['vendor', serverOf(() => Promise.reject(down))]]);
    const report = await mcpLockFindings(root, loaded, () => servers);
    expect(report.findings).toEqual([]);
    expect(report.warnings[0]).toContain('X_MCP_REMOTE_REFUSED');
  });

  test('a load that failed says nothing: the load finding owns it', async () => {
    const servers = new Map([['vendor', serverOf(async () => [])]]);
    const failed = async () => ({
      findings: [{ code: 'X_APP_MODULE_LOAD_FAILED', cause: 'c', fix: 'x verify', docs: '' }],
    });
    expect((await mcpLockFindings(root, failed, () => servers)).findings).toEqual([]);
  });
});
