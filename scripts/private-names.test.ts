// `scripts/private-names.ts` on fixture git trees: invented names through the environment, a hit
// reported by file:line and the entry's index, and never the name itself on stdout or in --json;
// then the same guard over this repository's own public tree.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temporary-directory primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no OS temp-dir lookup.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { render } from './lib/log';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  NOT_A_TREE,
  privateNameFindings,
  privateNameReport,
  REQUIRED_ENV,
  SELF,
  SKIP_NOTE,
  scanPrivateNames,
} from './private-names';
import { ENV_NAME, REPOS_ENV } from './private-names-match';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const NAMES = 'zorblax.io\nquimtel';
/** Built from parts, as the guard builds it: this file never carries the name whole. */
const MODE = ['dz', 'runner'].join('-');
const EMPTY = { names: [], repositories: [] } as const;
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A git tree holding `tracked` in the index and `untracked` beside it, plus a stand-in for the
 * guard itself unless `self` is false: the guard refuses a tree in which it did not read itself.
 */
async function tree(
  given: Readonly<Record<string, string>>,
  untracked: Readonly<Record<string, string>> = {},
  self = true,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-private-names-'));
  roots.push(root);
  const tracked = self ? { [SELF]: '// the guard\n', ...given } : given;
  for (const [path, text] of Object.entries({ ...tracked, ...untracked })) {
    await Bun.write(join(root, path), text);
  }
  const git = (args: readonly string[]) =>
    Bun.spawnSync(['git', ...args], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 10_000,
    }).exitCode;
  expect(git(['init', '-q'])).toBe(0);
  if (Object.keys(tracked).length > 0) expect(git(['add', '--', ...Object.keys(tracked)])).toBe(0);
  return root;
}

const run = (root: string, ...raw: [string | undefined] | []) =>
  privateNameReport(root, { [ENV_NAME]: raw.length === 0 ? NAMES : raw[0] });

/** A push to main on Actions. Not a trigger on its own: a unit job runs there with no secret. */
const MAIN_PUSH = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
} as const;

describe('private-names · a listed name in the tree', () => {
  test('a tracked line is refused by file:line and the 1-based index, never the name', async () => {
    const root = await tree({ 'src/a.ts': '// fine\n// measured on Quimtel, 2026-09-01\n' });
    const result = await run(root);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_PRIVATE_NAME', 'src/a.ts:2'],
    ]);
    expect(result.findings?.[0]?.cause).toContain(`entry 2 of ${ENV_NAME}`);
    for (const json of [false, true]) {
      const out = render(result, json).toLowerCase();
      expect(out).not.toContain('quimtel');
      expect(out).not.toContain('zorblax');
    }
  });

  test('case differs: refused; a domain entry matches its subdomain and a sentence-ending dot', async () => {
    const root = await tree({
      'a.md': 'QUIMTEL\nhttps://www.Zorblax.io/x\nsee zorblax.io.\n',
    });
    expect((await run(root)).findings?.map((finding) => finding.at)).toEqual([
      'a.md:1',
      'a.md:2',
      'a.md:3',
    ]);
  });

  test('the host check logs the "checked" line and returns the findings', async () => {
    const root = await tree({ 'a.md': 'quimtel\n' });
    const logged: string[] = [];
    const findings = await privateNameFindings(root, { [ENV_NAME]: NAMES }, (line) =>
      logged.push(line),
    );
    expect(findings.map((finding) => finding.at)).toEqual(['a.md:1']);
    expect(logged).toEqual(['private-names: checked 2 names across 2 files, 1 carry one']);
  });

  test('a listed name inside a longer token passes', async () => {
    const root = await tree({ 'a.ts': 'quimtels quimtel-tools quimtel.dev xquimtel zorblax\n' });
    expect((await run(root)).ok).toBe(true);
  });

  test('a name in a tracked path is refused, and the path is never printed', async () => {
    const root = await tree({ 'docs/quimtel/notes.md': 'nothing here\n', 'b.md': 'quimtel\n' });
    const result = await run(root);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_PRIVATE_NAME',
      'X_PRIVATE_NAME',
    ]);
    const out = render(result, true).toLowerCase();
    expect(out).not.toContain('quimtel');
    expect(out).toContain('git ls-files');
  });

  test('CHANGELOG.md, docs/changelog/, docs/history/ and docs/plans/ keep adopter names', async () => {
    const root = await tree({
      'CHANGELOG.md': 'quimtel\n',
      'docs/changelog/1.0.0.md': 'quimtel\n',
      'docs/history/a.md': 'quimtel\n',
      'docs/plans/2026/a.md': 'zorblax.io\n',
    });
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('private-names: checked 2 names across 5 files');
  });

  test('a tree holding the guard that git cannot list is refused, never a clean scan of nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-private-names-bare-'));
    roots.push(root);
    await Bun.write(join(root, SELF), '// the guard\n');
    await expect(scanPrivateNames(root, EMPTY)).rejects.toMatchObject({
      code: 'X_PRIVATE_NAME',
    });
  });

  // The host checks' own fixtures plant a few files in a temp directory that is no repository and
  // holds no guard: there is no public tree to vouch for, so the guard says it skipped.
  test('a planted directory that is neither a git tree nor holds the guard is a skip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-private-names-planted-'));
    roots.push(root);
    await Bun.write(join(root, 'a.md'), `${MODE}\nquimtel\n`);
    expect(await scanPrivateNames(root, EMPTY)).toBeUndefined();
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(NOT_A_TREE);
    const required = await privateNameReport(root, { [REQUIRED_ENV]: '1', [ENV_NAME]: 'quimtel' });
    expect(required.ok).toBe(true);
  });

  test('a tree in which the guard did not read itself is refused, never a clean scan', async () => {
    const root = await tree({ 'a.md': 'fine\n' }, {}, false);
    await expect(scanPrivateNames(root, EMPTY)).rejects.toMatchObject({
      code: 'X_PRIVATE_NAME',
      cause: expect.stringContaining(SELF),
    });
  });

  test('an untracked, unignored file is scanned before it is committed', async () => {
    const root = await tree({ '.gitignore': 'build/\n' }, { 'new-page.md': 'x\nquimtel\n' });
    expect((await run(root)).findings?.map((finding) => finding.at)).toEqual(['new-page.md:2']);
  });

  test('an ignored file passes; a binary file is skipped', async () => {
    const root = await tree(
      { '.gitignore': 'build/\n', 'bin.dat': 'quimtel\u0000\n' },
      { 'build/out.md': 'quimtel\n' },
    );
    expect((await run(root)).ok).toBe(true);
  });
});

describe('private-names · the public tree, every file and records too', () => {
  test('the setup mode is refused with no secret at all, in a record as anywhere', async () => {
    const root = await tree({
      'ci.yml': `# a ${MODE.toUpperCase()} box\n`,
      'docs/plans/2026/a.md': `x\nthe ${MODE}\n`,
      'fine.md': 'a bare VM\n',
    });
    const result = await privateNameReport(root, {});
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toEqual([
      'ci.yml:1',
      'docs/plans/2026/a.md:2',
    ]);
    const out = render(result, true).toLowerCase();
    expect(out).not.toContain(MODE);
    expect(out).toContain('setup mode');
  });

  test('a private repository from the secret is refused in a record, by index, never by name', async () => {
    const root = await tree({
      'docs/plans/2026/status.yml': 'evidence: ["#1", "zorblax-co/vault#1633"]\n',
      'docs/history/a.md': 'zorblax-co/vault-tools is another repository\n',
    });
    const result = await run(root, `quimtel\nZorblax-Co/Vault`);
    expect(result.findings?.map((finding) => [finding.at, finding.cause])).toEqual([
      ['docs/plans/2026/status.yml:1', expect.stringContaining('repository entry 1 of')],
    ]);
    expect(render(result, true).toLowerCase()).not.toContain('zorblax');
  });

  test('a path carrying the setup mode is refused and never printed', async () => {
    const root = await tree({ [`docs/${MODE}/a.md`]: 'fine\n' });
    const result = await privateNameReport(root, {});
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_PRIVATE_NAME']);
    expect(render(result, true).toLowerCase()).not.toContain(MODE);
  });

  test('.dz/ is hand-edited platform config: every rule applies there', async () => {
    const root = await tree({
      '.dz/briefs/x.md': `the ${MODE}\n`,
      '.dz/briefs/y.md': 'see zorblax-co/vault#3\n',
      '.dz/briefs/z.md': 'quimtel\n',
    });
    const result = await run(root, 'quimtel\nzorblax-co/vault');
    expect(result.findings?.map((finding) => [finding.at, finding.cause])).toEqual([
      ['.dz/briefs/x.md:1', expect.stringContaining('setup mode')],
      ['.dz/briefs/y.md:1', expect.stringContaining('repository entry 1 of')],
      ['.dz/briefs/z.md:1', expect.stringContaining('entry 1')],
    ]);
    expect(result.summary).toBe(
      'private-names: checked 1 names and 1 repositories across 4 files, 3 carry one',
    );
  });

  test('the repositories secret alone refuses a repository, and says the names were skipped', async () => {
    const root = await tree({
      'docs/history/a.md': 'see zorblax-co/vault#12\n',
      'b.md': 'quimtel\n',
    });
    const result = await privateNameReport(root, { [REPOS_ENV]: 'zorblax-co/vault' });
    expect(result.findings?.map((finding) => [finding.at, finding.cause])).toEqual([
      ['docs/history/a.md:1', expect.stringContaining(`repository entry 1 of ${ENV_NAME}`)],
    ]);
    expect(result.summary).toBe(
      `private-names: checked 1 repositories across 3 files; ${SKIP_NOTE}, 1 carry one`,
    );
    expect(render(result, true).toLowerCase()).not.toContain('zorblax');
  });

  test('both secrets together: names and repositories counted apart', async () => {
    const root = await tree({ 'a.md': 'fine\n' });
    const result = await privateNameReport(root, {
      [ENV_NAME]: 'quimtel',
      [REPOS_ENV]: 'zorblax-co/vault\nquimtel/ops',
    });
    expect(result.summary).toBe('private-names: checked 1 names and 2 repositories across 2 files');
  });
});

describe('private-names · unset is a skip, never a scan', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', ' \n\t, \n'],
  ])(
    '%s: exit 0, the names skipped and said so, the public tree still read',
    async (_label, raw) => {
      const root = await tree({ 'a.md': 'quimtel\n' });
      const result = await run(root, raw);
      expect(result.ok).toBe(true);
      const unset = `private-names: checked the setup mode across 2 files; ${SKIP_NOTE}`;
      expect(result.summary).toBe(unset);
      expect(render(result, false)).not.toContain('names across');
      const logged: string[] = [];
      expect(
        await privateNameFindings(root, { [ENV_NAME]: raw }, (line) => logged.push(line)),
      ).toEqual([]);
      expect(logged).toEqual([unset]);
    },
  );

  test('the required flag with the names secret missing is red, the repositories one or not', async () => {
    const root = await tree({ 'a.md': 'fine\n' });
    for (const [raw, repos] of [
      [undefined, undefined],
      ['', 'zorblax-co/vault'],
      [' \n', ''],
    ] as const) {
      const result = await privateNameReport(root, {
        [REQUIRED_ENV]: '1',
        [ENV_NAME]: raw,
        [REPOS_ENV]: repos,
      });
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_PRIVATE_NAMES_UNSET']);
      expect(result.summary).not.toContain(SKIP_NOTE);
    }
  });

  test.each([
    ['a push to main without the flag (the unit job)', MAIN_PUSH],
    ['a pull request', { ...MAIN_PUSH, GITHUB_EVENT_NAME: 'pull_request' }],
    ['a local run', {}],
    ['the flag set to anything but 1', { [REQUIRED_ENV]: '0' }],
    ['the flag empty', { [REQUIRED_ENV]: '' }],
  ])('%s with the secret missing still skips', async (_label, env) => {
    const root = await tree({ 'a.md': 'quimtel\n' });
    const result = await privateNameReport(root, { ...env, [ENV_NAME]: '' });
    expect(result.ok).toBe(true);
    expect(result.summary).toEndWith(SKIP_NOTE);
  });
});

describe('private-names · the list lives in a secret, never in the tree', () => {
  test('the script reads the names from process.env alone', async () => {
    const source = await Bun.file(join(repoRoot(), 'scripts', 'private-names.ts')).text();
    expect(source.match(/process\.env/g)?.length).toBe(1);
    // It reads only the tracked tree: no file read names a list of its own.
    expect(source).not.toMatch(/(Bun\.file|readFile\w*)\([^)]*\.(txt|json|ya?ml)/);
  });

  test('no tracked or addable file is a name list', () => {
    const files = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot(),
      timeout: 10_000,
    }).stdout.toString();
    const named = files.split('\n').filter((path) => /private-names/i.test(path));
    expect(named).toEqual([
      'scripts/private-names-match.test.ts',
      'scripts/private-names-match.ts',
      'scripts/private-names.test.ts',
      'scripts/private-names.ts',
    ]);
  });

  test('the script run with the variable unset prints the skip note and exits 0', () => {
    const run = Bun.spawnSync(['bun', 'run', 'scripts/private-names.ts', '--json'], {
      cwd: repoRoot(),
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      timeout: 30_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain(SKIP_NOTE);
  });
});

describe('private-names · this repository`s own public tree', () => {
  // The guard over the real `git ls-files`, no secret: what any contributor's `bun test` proves.
  test('carries no setup mode, and the guard read itself among every file', async () => {
    const result = await privateNameReport(repoRoot(), {});
    expect(result.findings ?? []).toEqual([]);
    expect(result.ok).toBe(true);
    const files = Number((result.data as { readonly files?: unknown } | undefined)?.files);
    // Thousands of files: a scan that silently read a handful would be a pass that proves nothing.
    expect(files).toBeGreaterThan(1000);
    expect(result.summary).toContain(`across ${files} files`);
  });
});
