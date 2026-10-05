// The enforcement half of #281: a workspace manifest that does not parse must leave here as an
// instruction naming the FILE, never as the bare `SyntaxError: Failed to parse JSON` that every
// release tool sitting on this module used to surface.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { ScriptError } from './script-error';
import type { Workspace } from './workspaces';
import {
  listWorkspaces,
  publishFloorFindings,
  publishOrder,
  publishSequence,
  readWorkspaceManifest,
  WORKSPACE_GLOB,
} from './workspaces';

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

  // Security audit of plan 101 sweep 1c: the manifest path is a directory name the glob matched,
  // and it rides into a `bun -e` the reader pastes.
  test('a workspace directory carrying shell syntax never reaches the bun -e line', async () => {
    const root = await tree({
      'packages/core/package.json': '{"name":"@ultimat3/core","version":"9.0.0"}',
      'packages/x$(touch pwned)/package.json': '{"name":',
    });
    const thrown = await listWorkspaces(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    const fix = (thrown as ScriptError).fix;
    const [command] = fix.split('#');
    expect(command).not.toContain('$(');
    expect(command?.trim()).toBe(
      `bun -e "console.log(await Bun.file('<the package.json the cause names>').json())"`,
    );
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

  // v22.4.0 published `core` and died before `schema`: alphabetical within a tier put a package
  // on npm ahead of the sibling it depends on, and npm versions are immutable.
  test('within a tier, a dependency publishes before its dependant whatever the alphabet says', async () => {
    const root = await tree({
      'packages/core/package.json':
        '{"name":"@ultimat3/core","version":"9.0.0","dependencies":{"@ultimat3/schema":"9.0.0"}}',
      'packages/schema/package.json': '{"name":"@ultimat3/schema","version":"9.0.0"}',
      'packages/cli/package.json':
        '{"name":"@ultimat3/cli","version":"9.0.0","dependencies":{"@ultimat3/testing":"9.0.0","@ultimat3/admin":"9.0.0"}}',
      'packages/testing/package.json': '{"name":"@ultimat3/testing","version":"9.0.0"}',
      'packages/admin/package.json': '{"name":"@ultimat3/admin","version":"9.0.0"}',
    });
    expect(publishOrder(await listWorkspaces(root)).map((one) => one.dir)).toEqual([
      'schema',
      'core',
      'admin',
      'testing',
      'cli',
    ]);
  });

  test(
    'this tree: every @ultimat3/* dependency publishes before the package naming it',
    async () => {
      const listed = publishOrder(await listWorkspaces(repoRoot()));
      const position = new Map(listed.map((one, index) => [one.name, index]));
      const late: string[] = [];
      for (const [index, one] of listed.entries()) {
        const manifest = (await Bun.file(join(one.path, 'package.json')).json()) as {
          readonly dependencies?: Readonly<Record<string, string>>;
        };
        for (const dep of Object.keys(manifest.dependencies ?? {})) {
          const at = position.get(dep);
          if (at !== undefined && at > index) late.push(`${one.name} before ${dep}`);
        }
      }
      // Vacuity guard: the two declared sideways edges this exists for are both in the tree.
      expect(listed.length).toBeGreaterThan(20);
      expect(late).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('a cycle cannot be ordered, so it keeps the alphabet rather than dropping a package', () => {
    const order = publishSequence([
      { dir: 'b', name: '@ultimat3/b', tier: 1, dependsOn: ['@ultimat3/a'] },
      { dir: 'a', name: '@ultimat3/a', tier: 1, dependsOn: ['@ultimat3/b'] },
      { dir: 'c', name: '@ultimat3/c', tier: 0, dependsOn: [] },
    ]);
    expect(order.map((one) => one.dir)).toEqual(['c', 'a', 'b']);
  });
});

describe('publishFloorFindings', () => {
  const one = (isPrivate: boolean): Workspace => ({
    dir: 'core',
    name: '@ultimat3/core',
    version: '9.0.0',
    private: isPrivate,
    path: '/nowhere/packages/core',
    tier: 0,
    dependsOn: [],
  });

  // `registry-audit` answered "0/0 … every one attested" and `release --check` "0 packages are
  // stamped" — ok: true — on a tree that enumerated nothing.
  test('zero publishable workspaces is a refusal, private-only included', () => {
    for (const workspaces of [[], [one(true)]]) {
      const findings = publishFloorFindings(workspaces);
      expect(findings.map((finding) => finding.code)).toEqual(['X_CORPUS_UNSCANNED']);
      expect(findings[0]?.cause).toContain(WORKSPACE_GLOB);
    }
  });

  test('one publishable workspace clears the floor', () => {
    expect(publishFloorFindings([one(false)])).toEqual([]);
  });
});
