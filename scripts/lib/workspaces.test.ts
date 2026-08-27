// The enforcement half of #281: a workspace manifest that does not parse must leave here as an
// instruction naming the FILE, never as the bare `SyntaxError: Failed to parse JSON` that every
// release tool sitting on this module used to surface.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ScriptError } from './script-error';
import { listWorkspaces, readWorkspaceManifest, WORKSPACE_GLOB } from './workspaces';

const roots: string[] = [];

const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-workspaces-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('readWorkspaceManifest', () => {
  test('reads a manifest into its three fields', async () => {
    const root = await tree({
      'packages/schema/package.json': '{"name":"@ultimat3/schema","version":"9.0.0"}',
    });
    const read = await readWorkspaceManifest(join(root, 'packages/schema/package.json'));
    expect(read.kind).toBe('read');
    expect(read.kind === 'read' ? read.manifest.version : '').toBe('9.0.0');
  });

  test('a trailing comma is `unparsable` with the parser own words, never a throw', async () => {
    const root = await tree({ 'packages/schema/package.json': '{"name":"x",}' });
    const read = await readWorkspaceManifest(join(root, 'packages/schema/package.json'));
    expect(read.kind).toBe('unparsable');
    expect(read.kind === 'unparsable' ? read.problem.length : 0).toBeGreaterThan(0);
  });

  test('JSON that parses to the wrong SHAPE is unparsable too — a cast made it read', async () => {
    const root = await tree({ 'packages/schema/package.json': '["@ultimat3/schema"]' });
    const read = await readWorkspaceManifest(join(root, 'packages/schema/package.json'));
    expect(read.kind).toBe('unparsable');
  });

  test('a manifest whose "version" is a number is unparsable, not version 0.0.0', async () => {
    const root = await tree({ 'packages/schema/package.json': '{"name":"x","version":9}' });
    const read = await readWorkspaceManifest(join(root, 'packages/schema/package.json'));
    expect(read.kind).toBe('unparsable');
  });

  test('a missing file is `absent`, which is not the same fact as broken', async () => {
    const root = await tree({ 'packages/schema/package.json': '{}' });
    expect((await readWorkspaceManifest(join(root, 'packages/none/package.json'))).kind).toBe(
      'absent',
    );
  });
});

describe('listWorkspaces', () => {
  test('names the file, carries a code and an executable fix — #281', async () => {
    const root = await tree({
      'packages/core/package.json': '{"name":"@ultimat3/core","version":"9.0.0"}',
      'packages/schema/package.json': '{"name":"@ultimat3/schema","version":"9.0.0",}',
    });
    const thrown = await listWorkspaces(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ScriptError);
    const failure = thrown as ScriptError;
    expect(failure.code).toBe('X_WORKSPACE_MANIFEST_UNREADABLE');
    expect(failure.cause).toContain('packages/schema/package.json');
    expect(failure.fix).toContain('packages/schema/package.json');
    // Executable first, prose behind a `#` — the rule `version-stamps.ts` states for its own pair.
    expect(failure.fix.startsWith('bun ')).toBe(true);
  });

  test('a readable tree still lists, sorted by tier then directory', async () => {
    const root = await tree({
      'packages/cli/package.json': '{"name":"@ultimat3/cli","version":"9.0.0"}',
      'packages/core/package.json': '{"name":"@ultimat3/core","version":"9.0.0"}',
    });
    expect((await listWorkspaces(root)).map((one) => one.dir)).toEqual(['core', 'cli']);
  });

  test('the glob is exported, so the refusal can name what it scanned', () => {
    expect(WORKSPACE_GLOB).toBe('packages/*/package.json');
  });
});
