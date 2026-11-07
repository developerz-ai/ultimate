// The `manifest` step's MCP rider: an app whose `app.config.ts` says `ai.mcp.expose: true` and
// mounts nothing is red with the boot's own `X_MCP_APP_UNMOUNTED`, where it used to be a log line
// every boot printed and nobody read while `POST /mcp` answered 404.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { mcpMountFindings } from './verify-mcp-mount';

const FIXTURES = join(tmpdir(), `x-verify-mcp-mount-${process.pid}`);
const loaded = async () => ({ findings: [] });

const fixture = async (name: string, files: Readonly<Record<string, string>>): Promise<string> => {
  const root = join(FIXTURES, name);
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
};

const config = (expose: boolean): string =>
  `export const config = { name: 'demo', ai: { mcp: { expose: ${String(expose)} } } };\n`;

const MOUNTED = `export const mcp = {
  server: {},
  tools: [],
  route: { method: 'POST', path: '/mcp', handle: async () => new Response('ok') },
};
`;

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true });
});

describe('unit · mcpMountFindings', () => {
  test('expose: true and no apps/<app>/mcp.ts is X_MCP_APP_UNMOUNTED', async () => {
    const root = await fixture('missing', { 'app.config.ts': config(true) });
    const findings = await mcpMountFindings(root, loaded);
    expect(findings.map((finding) => finding.code)).toEqual(['X_MCP_APP_UNMOUNTED']);
    expect(findings[0]?.fix).toContain('apps/web/mcp.ts');
  });

  test('an export with no route is red too: it mounts nothing', async () => {
    const root = await fixture('no-route', {
      'app.config.ts': config(true),
      'apps/web/mcp.ts': 'export const mcp = { server: {}, tools: [], route: undefined };\n',
    });
    expect((await mcpMountFindings(root, loaded)).map((finding) => finding.code)).toEqual([
      'X_MCP_APP_UNMOUNTED',
    ]);
  });

  test('a mounted endpoint, or expose: false, is green', async () => {
    const mounted = await fixture('mounted', {
      'app.config.ts': config(true),
      'apps/web/mcp.ts': MOUNTED,
    });
    expect(await mcpMountFindings(mounted, loaded)).toEqual([]);
    const off = await fixture('off', { 'app.config.ts': config(false) });
    expect(await mcpMountFindings(off, loaded)).toEqual([]);
  });

  test('an app that did not load is reported once, by the load findings, never here', async () => {
    const root = await fixture('broken', { 'app.config.ts': config(true) });
    const broken = async () => ({
      findings: [{ code: 'X_APP_MODULE_LOAD_FAILED', cause: 'x', fix: 'y' }],
    });
    expect(await mcpMountFindings(root, broken)).toEqual([]);
  });
});
