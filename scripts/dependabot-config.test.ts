// Keep dependency updates in their declared Bun workspace context without admitting grouped majors.
import { beforeAll, describe, expect, test } from 'bun:test';
import { dependencyManifestPaths, scanWorkspaceManifests } from './dependency-allowlist';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

interface BunGroup {
  readonly 'update-types'?: readonly string[];
}

interface Update {
  readonly 'package-ecosystem': string;
  readonly directory?: string;
  readonly directories?: readonly string[];
  readonly groups?: Readonly<Record<string, BunGroup>>;
}

function rootContextOnly(updates: readonly Update[]): boolean {
  const bun = updates.filter((update) => update['package-ecosystem'] === 'bun');
  if (bun.length !== 1) return false;
  const update = bun[0];
  if (!update) return false;
  const directories = update.directories ?? (update.directory ? [update.directory] : []);
  return directories.length === 1 && directories[0] === '/';
}

function uncoveredManifests(
  updates: readonly Update[],
  required: readonly string[],
  workspaces: readonly string[],
): string[] {
  // Root is a resolution context, not recursive directory coverage. Only declared members count.
  const patterns = workspaces.map((pattern) => new Bun.Glob(`${pattern}/package.json`));
  return required.filter(
    (manifest) =>
      !rootContextOnly(updates) ||
      (manifest !== 'package.json' && !patterns.some((pattern) => pattern.match(manifest))),
  );
}

function onlyMinorAndPatch(group: BunGroup | undefined): boolean {
  const types = group?.['update-types'];
  return types?.length === 2 && types.includes('minor') && types.includes('patch');
}

let updates: readonly Update[] = [];
let required: readonly string[] = [];
let members: readonly string[] = [];
let workspaces: readonly string[] = [];

beforeAll(async () => {
  const root = repoRoot();
  const scan = await scanWorkspaceManifests(root);
  // A partial or empty scan must never pass as complete coverage.
  expect(scan.unreadable).toBeUndefined();
  expect(scan.names.size).toBeGreaterThan(0);
  expect(scan.declarations.length).toBeGreaterThan(0);
  const external = scan.declarations.filter((declaration) => !scan.names.has(declaration.name));
  expect(external.length).toBeGreaterThan(0);
  required = [...new Set(external.map(({ manifest }) => manifest))].sort();
  members = await dependencyManifestPaths(root);
  expect(members.length).toBeGreaterThan(0);
  const manifest: { readonly workspaces: readonly string[] } = await Bun.file(
    `${root}/package.json`,
  ).json();
  expect(Array.isArray(manifest.workspaces)).toBe(true);
  expect(manifest.workspaces.length).toBeGreaterThan(0);
  expect(manifest.workspaces.every((pattern: unknown) => typeof pattern === 'string')).toBe(true);
  workspaces = manifest.workspaces;
  // This is the lock context the root job updates, not a claim about remote Dependabot execution.
  expect(await Bun.file(`${root}/bun.lock`).exists()).toBe(true);
  const config = Bun.YAML.parse(await Bun.file(`${root}/.github/dependabot.yml`).text()) as {
    readonly updates: readonly Update[];
  };
  expect(Array.isArray(config.updates)).toBe(true);
  updates = config.updates;
}, REPO_SCAN_TIMEOUT_MS);

describe('unit · Dependabot · external workspace dependencies', () => {
  test('one root Bun context covers every external declaration through workspace membership', () => {
    expect(rootContextOnly(updates)).toBe(true);
    expect(uncoveredManifests(updates, required, workspaces)).toEqual([]);
    // Internal-only siblings must also stay local to this context.
    expect(uncoveredManifests(updates, members, workspaces)).toEqual([]);
  });

  test('removing root coverage leaves every external declaration uncovered', () => {
    const missing = updates.filter((update) => update['package-ecosystem'] !== 'bun');
    expect(uncoveredManifests(missing, required, workspaces)).toEqual([...required]);
    expect(
      uncoveredManifests([{ 'package-ecosystem': 'bun', directories: [] }], required, workspaces),
    ).toEqual([...required]);
  });

  test('restoring isolated manifest directories rejects the original resolution contexts', () => {
    const isolated = required.map((manifest) =>
      manifest === 'package.json' ? '/' : `/${manifest.slice(0, -'/package.json'.length)}`,
    );
    const mutation = [{ 'package-ecosystem': 'bun', directories: isolated }];
    expect(isolated).toContain('/examples/dummy/apps/web');
    expect(isolated).toContain('/examples/dummy/packages/ui');
    expect(rootContextOnly(mutation)).toBe(false);
    expect(uncoveredManifests(mutation, required, workspaces)).toEqual([...required]);
  });

  test('adding an isolated Postly job beside root coverage is rejected', () => {
    for (const directory of ['/examples/dummy/apps/web', '/examples/dummy/packages/ui']) {
      expect(rootContextOnly([...updates, { 'package-ecosystem': 'bun', directory }])).toBe(false);
    }
  });

  test('root and parent directory prefixes do not cover nonmember manifests', () => {
    const nonmember = 'examples/dummy/not-a-workspace/package.json';
    const root = [{ 'package-ecosystem': 'bun', directory: '/' }];
    expect(uncoveredManifests(root, [nonmember], workspaces)).toEqual([nonmember]);
    expect(
      uncoveredManifests(
        [{ 'package-ecosystem': 'bun', directory: '/examples/dummy' }],
        ['examples/dummy/apps/web/package.json'],
        workspaces,
      ),
    ).toEqual(['examples/dummy/apps/web/package.json']);
  });

  test('removing workspace declarations uncovers their external dependencies', () => {
    expect(uncoveredManifests(updates, required, [])).toEqual(
      required.filter((manifest) => manifest !== 'package.json'),
    );
    for (const pattern of workspaces) {
      const glob = new Bun.Glob(`${pattern}/package.json`);
      const affected = required.filter((manifest) => glob.match(manifest));
      if (affected.length === 0) continue;
      expect(
        uncoveredManifests(
          updates,
          required,
          workspaces.filter((entry) => entry !== pattern),
        ),
      ).toEqual(affected);
    }
  });
});

describe('unit · Dependabot · grouped majors stay opt-in', () => {
  for (const name of ['dev-tooling', 'runtime']) {
    test(`${name} permits exactly minor and patch updates`, () => {
      const bun = updates.find((update) => update['package-ecosystem'] === 'bun');
      expect(onlyMinorAndPatch(bun?.groups?.[name])).toBe(true);
    });

    test(`${name} rejects major eligibility`, () => {
      const bun = updates.find((update) => update['package-ecosystem'] === 'bun');
      const group = bun?.groups?.[name];
      expect(
        onlyMinorAndPatch({
          ...group,
          'update-types': [...(group?.['update-types'] ?? []), 'major'],
        }),
      ).toBe(false);
    });

    test(`${name} rejects absent update-types`, () => {
      const bun = updates.find((update) => update['package-ecosystem'] === 'bun');
      const group = { ...bun?.groups?.[name] };
      delete group['update-types'];
      expect(onlyMinorAndPatch(group)).toBe(false);
    });
  }
});
