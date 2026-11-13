// `bun run setup`'s MCP config step: the example is copied when `.mcp.json` is absent, a file a
// contributor already has is kept byte for byte, and a tree with no example writes nothing.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory native; each case needs a throwaway repo root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { copyMcpConfig, MCP_CONFIG, MCP_EXAMPLE } from './mcp-config';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-config-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
}

describe('unit · bun run setup writes .mcp.json from the example', () => {
  test('absent: the example is copied, and a second run keeps it', async () => {
    const root = await tree({ [MCP_EXAMPLE]: '{"mcpServers":{}}\n' });
    expect(await copyMcpConfig(root)).toBe('wrote');
    expect(await Bun.file(join(root, MCP_CONFIG)).text()).toBe('{"mcpServers":{}}\n');
    expect(await copyMcpConfig(root)).toBe('kept');
  });

  test('present: a contributor’s own file is never overwritten', async () => {
    const root = await tree({ [MCP_EXAMPLE]: '{"a":1}\n', [MCP_CONFIG]: '{"mine":true}\n' });
    expect(await copyMcpConfig(root)).toBe('kept');
    expect(await Bun.file(join(root, MCP_CONFIG)).text()).toBe('{"mine":true}\n');
  });

  test('no example: nothing is written', async () => {
    const root = await tree({});
    expect(await copyMcpConfig(root)).toBe('no-example');
    expect(await Bun.file(join(root, MCP_CONFIG)).exists()).toBe(false);
  });

  test('the repository tracks the example and ignores the copy', async () => {
    const root = join(import.meta.dir, '..', '..');
    expect(await Bun.file(join(root, MCP_EXAMPLE)).exists()).toBe(true);
    const ignored = (await Bun.file(join(root, '.gitignore')).text()).split('\n');
    expect(ignored).toContain(`/${MCP_CONFIG}`);
    expect(ignored).not.toContain(`/${MCP_EXAMPLE}`);
  });
});
