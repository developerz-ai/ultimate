// `scripts/private-names.ts` on fixture git trees: invented names through the environment, a hit
// reported by file:line and the entry's index, and never the name itself on stdout or in --json.

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
  ENV_NAME,
  namesFromEnv,
  privateNameFindings,
  privateNameReport,
  REQUIRED_ENV,
  SKIP_NOTE,
  scanPrivateNames,
  tokenMatch,
} from './private-names';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const NAMES = 'zorblax.io\nquimtel';
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A git tree holding `tracked` in the index and `untracked` beside it. */
async function tree(
  tracked: Readonly<Record<string, string>>,
  untracked: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-private-names-'));
  roots.push(root);
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
    expect(logged).toEqual(['private-names: checked 2 names across 1 files, 1 carry one']);
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

  test('CHANGELOG.md, docs/history/ and docs/plans/ are records and pass', async () => {
    const root = await tree({
      'CHANGELOG.md': 'quimtel\n',
      'docs/history/a.md': 'quimtel\n',
      'docs/plans/2026/a.md': 'zorblax.io\n',
    });
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('checked 2 names across 0 files');
  });

  test('a tree git cannot list is refused, never a clean scan of nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-private-names-bare-'));
    roots.push(root);
    await expect(scanPrivateNames(root, ['quimtel'])).rejects.toMatchObject({
      code: 'X_PRIVATE_NAME',
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

describe('private-names · unset is a skip, never a scan', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', ' \n\t, \n'],
  ])('%s: exit 0 with the skip note and no "checked" line', async (_label, raw) => {
    const root = await tree({ 'a.md': 'quimtel\n' });
    const result = await run(root, raw);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(SKIP_NOTE);
    expect(render(result, false)).not.toContain('checked');
    const logged: string[] = [];
    expect(
      await privateNameFindings(root, { [ENV_NAME]: raw }, (line) => logged.push(line)),
    ).toEqual([]);
    expect(logged).toEqual([SKIP_NOTE]);
  });

  test('the required flag with the secret missing is red, never a skip', async () => {
    const root = await tree({ 'a.md': 'fine\n' });
    for (const raw of [undefined, '', ' \n']) {
      const result = await privateNameReport(root, { [REQUIRED_ENV]: '1', [ENV_NAME]: raw });
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_PRIVATE_NAMES_UNSET']);
      expect(result.summary).not.toBe(SKIP_NOTE);
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
    expect(result.summary).toBe(SKIP_NOTE);
  });

  test('comma- or newline-separated, trimmed and lowercased', () => {
    expect(namesFromEnv({ [ENV_NAME]: ' Quimtel ,zorblax.io\n\n' })).toEqual([
      'quimtel',
      'zorblax.io',
    ]);
  });

  test('a token matches exactly, or as a subdomain of a dotted entry', () => {
    expect(tokenMatch('quimtel', ['quimtel'])).toBe(1);
    expect(tokenMatch('a.zorblax.io', ['quimtel', 'zorblax.io'])).toBe(2);
    expect(tokenMatch('a.quimtel', ['quimtel'])).toBeUndefined();
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
    expect(named).toEqual(['scripts/private-names.test.ts', 'scripts/private-names.ts']);
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
