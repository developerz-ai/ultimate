// `releaseResult` over a fixture repository and a scripted git: every refusal in the order the run
// reaches it, the dry run that writes nothing, and the real bump that stamps every manifest and
// promotes [Unreleased]. The subprocesses are a table, so no test here touches this checkout.

import { describe, expect, test } from 'bun:test';
import { tempTree } from '../packages/testing/src/temp-tree';
import { parseScriptArgs } from './lib/args';
import type { RunResult } from './lib/run';
import { type ReleaseDeps, releaseResult } from './release';

const INDEX = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- a thing.',
  '',
  '## Releases',
  '',
  '| Version | Date | Summary |',
  '|---|---|---|',
  '| [1.2.0](docs/changelog/1.2.0.md) | 2026-08-10 | — |',
  '',
].join('\n');

const manifest = (name: string, version: string, deps: Record<string, string> = {}): string =>
  `${JSON.stringify({ name, version, dependencies: deps }, null, 2)}\n`;

/** A repo-shaped tree: two lockstep packages at `version`, a changelog index and one release. */
async function seed(root: string, input: { core?: string; index?: string } = {}): Promise<void> {
  await Bun.write(
    `${root}/package.json`,
    JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }),
  );
  await Bun.write(
    `${root}/packages/core/package.json`,
    manifest('@ultimat3/core', input.core ?? '1.2.0'),
  );
  await Bun.write(
    `${root}/packages/schema/package.json`,
    manifest('@ultimat3/schema', '1.2.0', { '@ultimat3/core': '1.2.0', other: '^3.0.0' }),
  );
  await Bun.write(`${root}/CHANGELOG.md`, input.index ?? INDEX);
  await Bun.write(`${root}/docs/changelog/1.2.0.md`, '## 1.2.0 - 2026-08-10\n\n- first\n');
}

const answer = (command: readonly string[], ok: boolean, output = ''): RunResult => ({
  command,
  code: ok ? 0 : 1,
  ok,
  output,
  durationMs: 1,
  timedOut: false,
});

interface Script {
  status?: string;
  branch?: string;
  upstream?: string;
  log?: string;
  gh?: string;
}

/** git and gh by table: an absent row is a command that failed. */
function scripted(script: Script): { deps: Omit<ReleaseDeps, 'root'>; ran: string[] } {
  const ran: string[] = [];
  const rows: Record<string, string | undefined> = {
    'git status --porcelain': script.status,
    'git branch --show-current': script.branch,
    'git rev-parse --abbrev-ref @{upstream}': script.upstream,
    'git log --pretty=format:%s v1.2.0..HEAD': script.log,
  };
  return {
    ran,
    deps: {
      now: new Date('2026-09-01T12:00:00Z'),
      run: async (command) => {
        const line = command.join(' ');
        ran.push(line);
        const output = command[0] === 'gh' ? script.gh : rows[line];
        return answer(command, output !== undefined, output ?? 'fatal');
      },
      // No compiler over a fixture: a surface with nothing pending, as a tree with no break reads.
      readApi: async () => ({
        findings: [],
        diff: { breaks: [], compatible: [], added: [] },
        symbols: 0,
        migratedFrom: [],
      }),
    },
  };
}

const CLEAN: Script = {
  status: '',
  branch: 'chore/release-1.3.0',
  log: 'feat: one\nfix: two\n',
  gh: '[]',
};

const release = async (root: string, argv: readonly string[], script: Script = CLEAN) => {
  const { deps, ran } = scripted(script);
  const result = await releaseResult(parseScriptArgs(argv), { ...deps, root });
  return { result, ran, codes: (result.findings ?? []).map((finding) => finding.code) };
};

describe('releaseResult · refusals, in the order the run reaches them', () => {
  test('a tree with no publishable workspace is refused before anything else is read', async () => {
    await using tree = tempTree('release-result-');
    const { result, codes, ran } = await release(tree.path, ['--bump', 'minor']);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('refusing: no publishable workspace');
    expect(codes).toEqual(['X_CORPUS_UNSCANNED']);
    expect(ran).toEqual([]);
  });

  test('an undecidable version is refused, naming the current one', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result } = await release(tree.path, ['--bump', 'sideways']);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not decidable');
    expect(result.data).toEqual({ current: '1.2.0' });
  });

  test('a major inside the window is refused before git is asked anything', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path, { core: '31.0.0' });
    await Bun.write(
      `${tree.path}/packages/schema/package.json`,
      manifest('@ultimat3/schema', '31.0.0'),
    );
    await Bun.write(
      `${tree.path}/docs/changelog/31.0.0.md`,
      '## 31.0.0 - 2026-08-20\n\n### Highlights\n\n- one\n',
    );
    const { result, codes, ran } = await release(tree.path, ['--bump', 'major']);
    expect(result.summary).toContain('refusing to release 32.0.0');
    expect(codes).toEqual(['X_RELEASE_MAJOR_WINDOW']);
    expect(ran).toEqual([]);
  });

  test('a dirty tree is refused, and the fix repeats this run', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result, codes } = await release(tree.path, ['--bump', 'minor', '--dry-run', '--json'], {
      ...CLEAN,
      status: ' M README.md\n',
    });
    expect(result.summary).toBe('refusing to release: the working tree is not clean');
    expect(codes).toEqual(['X_RELEASE_TREE_DIRTY']);
    expect(result.findings?.[0]?.fix).toContain(
      'bun run scripts/release.ts --bump minor --dry-run --json',
    );
  });

  test('a bump branch named like a maintenance line is refused', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result, codes } = await release(tree.path, ['--bump', 'minor'], {
      ...CLEAN,
      branch: 'release/1.3.0',
    });
    expect(result.summary).toBe('refusing to release: the branch is named like a maintenance line');
    expect(codes).toEqual(['X_RELEASE_BRANCH_NAME']);
  });

  test('a minor on a maintenance lane is refused: the lane ships patches only', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result, codes } = await release(tree.path, ['--bump', 'minor'], {
      ...CLEAN,
      branch: 'fix/thing',
      upstream: 'origin/release/1.x',
    });
    expect(result.summary).toBe(
      'refusing to release: release/1.x ships patches of its own major only',
    );
    expect(codes).toEqual(['X_RELEASE_LANE_PATCH_ONLY']);
  });

  test('a changelog with no [Unreleased] cannot be promoted, and nothing is written', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path, { index: '# Changelog\n\n## Releases\n' });
    const { result } = await release(tree.path, ['--bump', 'minor']);
    expect(result.summary).toBe('refusing to release: CHANGELOG.md cannot be promoted');
    expect(await Bun.file(`${tree.path}/packages/core/package.json`).text()).toContain('"1.2.0"');
  });
});

describe('releaseResult · --check', () => {
  test('a stamp the tree does not carry is a finding per file', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result, ran } = await release(tree.path, ['--check', '9.9.9']);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('this repo is not at 9.9.9');
    expect(result.data).toEqual({ check: '9.9.9', packages: 2 });
    expect(ran).toEqual([]);
  });

  test('a value that is not semver is a bad flag, never a scan', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result, codes } = await release(tree.path, ['--check', 'latest']);
    expect(result.summary).toContain('1 finding(s)');
    expect(codes).toEqual(['X_CLI_BAD_FLAG']);
  });
});

describe('releaseResult · the bump', () => {
  test('a dry run reports the plan, the commits and the closing ask, and writes nothing', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const before = await Bun.file(`${tree.path}/packages/schema/package.json`).text();
    const { result, ran } = await release(tree.path, ['--bump', 'minor', '--dry-run'], {
      ...CLEAN,
      gh: JSON.stringify([{ number: 7, title: 'Release 1.3.0' }]),
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('would release 2 packages at 1.3.0');
    expect(result.lines).toContain('  commits   2 since v1.2.0, appended under ### Commits');
    expect(result.lines?.some((line) => line.includes('`Fixes #7`'))).toBe(true);
    expect(result.data).toMatchObject({
      version: '1.3.0',
      previous: '1.2.0',
      changelogDate: '2026-09-01',
      openAsk: { number: 7 },
    });
    expect(ran.some((line) => line.startsWith('gh issue list'))).toBe(true);
    expect(await Bun.file(`${tree.path}/packages/schema/package.json`).text()).toBe(before);
    expect(await Bun.file(`${tree.path}/docs/changelog/1.3.0.md`).exists()).toBe(false);
  });

  test('a clone without the previous tag says so, and a failed ask lookup is one line, not a failure', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { result } = await release(tree.path, ['--bump', 'patch', '--dry-run'], {
      status: '',
      branch: 'chore/release-1.2.1',
    });
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      '  commits   none listed — this clone has no v1.2.0 tag to bound the range',
    );
    expect(result.lines?.some((line) => line.startsWith('  ask       lookup failed'))).toBe(true);
    expect(result.data).toMatchObject({ previousTagFound: false, commits: 0 });
  });

  test('the real bump stamps every manifest, repins exact siblings only, and promotes the changelog', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path, { core: '1.1.0' });
    const { deps } = scripted(CLEAN);
    const result = await releaseResult(parseScriptArgs(['--version', '1.3.0']), {
      ...deps,
      root: tree.path,
      performWrites: async () => ({ writes: [], findings: [] }),
      writeLock: async () => ({ line: '  api-lock  written' }),
    });
    // The skew is reported AND realigned: core was behind, so the run is not ok.
    expect(result.ok).toBe(false);
    expect((result.findings ?? []).map((finding) => finding.code)).toEqual([
      'X_RELEASE_VERSION_SKEW',
    ]);
    expect(result.summary).toBe('2 packages set to 1.3.0');
    const core = await Bun.file(`${tree.path}/packages/core/package.json`).json();
    const schema = await Bun.file(`${tree.path}/packages/schema/package.json`).json();
    expect(core.version).toBe('1.3.0');
    expect(schema.dependencies).toEqual({ '@ultimat3/core': '1.3.0', other: '^3.0.0' });
    expect(await Bun.file(`${tree.path}/docs/changelog/1.3.0.md`).text()).toContain('a thing.');
    expect(await Bun.file(`${tree.path}/CHANGELOG.md`).text()).toContain('docs/changelog/1.3.0.md');
    expect(result.lines).toContain('  api-lock  written');
  });

  test('a derived write that fails makes the bump fail, and a rehearsal leaves the changelog alone', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    const { deps, ran } = scripted(CLEAN);
    const finding = { code: 'X_LOCKFILE_STALE', cause: 'no lockfile', fix: 'bun install' };
    const result = await releaseResult(parseScriptArgs(['--bump', 'minor', '--rehearse']), {
      ...deps,
      root: tree.path,
      performWrites: async () => ({ writes: [], findings: [finding] }),
      writeLock: async () => ({ line: '  api-lock  x', finding }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('rehearsed 2 packages at 1.3.0');
    expect(result.findings).toEqual([finding, finding]);
    expect(await Bun.file(`${tree.path}/docs/changelog/1.3.0.md`).exists()).toBe(false);
    expect(await Bun.file(`${tree.path}/CHANGELOG.md`).text()).toBe(INDEX);
    expect(ran.some((line) => line.startsWith('gh '))).toBe(false);
    const core = await Bun.file(`${tree.path}/packages/core/package.json`).json();
    expect(core.version).toBe('1.3.0');
  });

  test('a file that cannot be written stops the bump and names what moved', async () => {
    await using tree = tempTree('release-result-');
    await seed(tree.path);
    // A directory where the promoted release file goes: the manifests move, the file cannot.
    await Bun.write(`${tree.path}/docs/changelog/1.3.0.md/keep`, '');
    const { result } = await release(tree.path, ['--bump', 'minor']);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('refusing to continue: the bump stopped after 2 file(s)');
    expect(result.lines).toEqual([
      '  wrote     packages/core/package.json',
      '  wrote     packages/schema/package.json',
    ]);
  });
});
