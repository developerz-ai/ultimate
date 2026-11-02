// Keep every external-dependency manifest visible to Dependabot without admitting grouped majors.
import { beforeAll, describe, expect, test } from 'bun:test';
import { scanWorkspaceManifests } from './dependency-allowlist';
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

function uncoveredDirectories(updates: readonly Update[], required: readonly string[]): string[] {
  const configured = new Set(
    updates
      .filter((update) => update['package-ecosystem'] === 'bun')
      .flatMap((update) => update.directories ?? (update.directory ? [update.directory] : [])),
  );
  // No prefix matching: / does not cover /packages/cli, nor does a parent cover a nested app.
  return required.filter((directory) => !configured.has(directory));
}

function onlyMinorAndPatch(group: BunGroup | undefined): boolean {
  const types = group?.['update-types'];
  return types?.length === 2 && types.includes('minor') && types.includes('patch');
}

let updates: readonly Update[] = [];
let required: readonly string[] = [];

beforeAll(async () => {
  const root = repoRoot();
  const scan = await scanWorkspaceManifests(root);
  // A partial or empty scan must never pass as complete coverage.
  expect(scan.unreadable).toBeUndefined();
  expect(scan.names.size).toBeGreaterThan(0);
  expect(scan.declarations.length).toBeGreaterThan(0);
  const external = scan.declarations.filter((declaration) => !scan.names.has(declaration.name));
  expect(external.length).toBeGreaterThan(0);
  required = [
    ...new Set(
      external.map(({ manifest }) =>
        manifest === 'package.json' ? '/' : `/${manifest.slice(0, -'/package.json'.length)}`,
      ),
    ),
  ].sort();
  const config = Bun.YAML.parse(await Bun.file(`${root}/.github/dependabot.yml`).text()) as {
    readonly updates: readonly Update[];
  };
  expect(Array.isArray(config.updates)).toBe(true);
  updates = config.updates;
}, REPO_SCAN_TIMEOUT_MS);

describe('unit · Dependabot · external workspace dependencies', () => {
  test('every manifest parent is explicitly covered by the bun ecosystem', () => {
    expect(updates.filter((update) => update['package-ecosystem'] === 'bun')).toHaveLength(1);
    expect(uncoveredDirectories(updates, required)).toEqual([]);
  });

  test('removing any required directory leaves that manifest uncovered', () => {
    for (const directory of required) {
      const missing = updates.map((update): Update => {
        if (update['package-ecosystem'] !== 'bun') return update;
        const { directory: single, directories, ...rest } = update;
        return {
          ...rest,
          directories: [...(directories ?? []), ...(single ? [single] : [])].filter(
            (entry) => entry !== directory,
          ),
        };
      });
      expect(uncoveredDirectories(missing, required)).toEqual([directory]);
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
