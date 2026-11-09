// `bun test packages/<pkg>` is a substring FILTER, not a path: at the repo root it also runs
// `examples/dummy/packages/<pkg>/…` under the wrong config, and those fail. Thirty-odd pages handed
// a reader that spelling while CLAUDE.md said "always ./" — a convention nothing enforced.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { checkDocTestPaths, docTestPathFindingFor, readTestPathPages } from './doc-test-paths';
import { bareTestPaths } from './lib/bun-test-paths';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const page = (text: string, path = 'wiki/Page.md') => ({ path, text });

describe('unit · what a bare path is', () => {
  test('a slash-bearing positional with no ./ is the finding', () => {
    expect(bareTestPaths('bun test packages/core')).toEqual(['packages/core']);
    expect(bareTestPaths('bun test scripts/doc-commands.test.ts')).toEqual([
      'scripts/doc-commands.test.ts',
    ]);
    expect(bareTestPaths('bun test packages/<pkg>')).toEqual(['packages/<pkg>']);
  });

  test('./, ../ and absolute paths are paths; a bare name is a name filter', () => {
    expect(bareTestPaths('bun test ./packages/core/')).toEqual([]);
    expect(bareTestPaths('bun test ../ultimate/packages/core')).toEqual([]);
    expect(bareTestPaths('bun test /abs/packages/core')).toEqual([]);
    expect(bareTestPaths('bun test errors')).toEqual([]);
    expect(bareTestPaths('bun test')).toEqual([]);
    // A leading placeholder is the reader's to fill — `./` included — so it is not judged.
    expect(bareTestPaths('bun test <path>/entity.test.ts')).toEqual([]);
  });

  test('a flag value is not a positional — `-t` takes a test name, which may hold a slash', () => {
    expect(bareTestPaths("bun test ./packages/core/ -t 'a/b'")).toEqual([]);
    expect(bareTestPaths('bun test --timeout 9000 ./packages/x/')).toEqual([]);
    expect(bareTestPaths('bun test --coverage packages/x')).toEqual(['packages/x']);
    expect(bareTestPaths('bun test --test-name-pattern=a/b packages/x')).toEqual(['packages/x']);
  });

  test('the command ends at a shell separator, and every bun test on a line is read', () => {
    expect(bareTestPaths('bun test ./a/ && cd packages/x')).toEqual([]);
    expect(bareTestPaths('bun test ./a/ ; bun test b/c')).toEqual(['b/c']);
    expect(bareTestPaths('bun test ./a/ # see packages/x')).toEqual([]);
  });

  test('a quoted positional is still a positional', () => {
    expect(bareTestPaths("bun test 'packages/core'")).toEqual(['packages/core']);
  });
});

describe('unit · the page rule', () => {
  test('a code span and a shell fence are read; prose and a ts fence are not', () => {
    const found = checkDocTestPaths([
      page('run `bun test packages/core` first\n```sh\nbun test packages/http\n```'),
      page('bun test packages/prose is not a span\n```ts\nbun test packages/ts\n```', 'b.md'),
    ]);
    expect(found.map((gap) => `${gap.at} ${gap.path}`)).toEqual([
      'wiki/Page.md:1 packages/core',
      'wiki/Page.md:3 packages/http',
    ]);
  });

  test('the finding is coded, names the line and hands back the ./ spelling', () => {
    const [gap] = checkDocTestPaths([page('`bun test packages/core`')]);
    if (gap === undefined) expect.unreachable('a bare path must be a finding');
    const finding = docTestPathFindingFor(gap);
    expect(finding.code).toBe('X_DOC_TEST_PATH_BARE');
    expect(finding.at).toBe('wiki/Page.md:1');
    expect(finding.fix).toContain('bun test ./packages/core');
  });

  test('NO FILE READ is a failure, never a pass', () => {
    const found = checkDocTestPaths([]);
    expect(found).toHaveLength(1);
    expect(docTestPathFindingFor(found[0] as never).code).toBe('X_DOC_TEST_PATH_UNSCANNED');
  });
});

describe('unit · against this repo', () => {
  test('the agent briefs under .claude/ and the package pages are read', async () => {
    const paths = (await readTestPathPages(repoRoot())).map((file) => file.path);
    expect(paths).toContain('.claude/commands/feature.md');
    expect(paths).toContain('packages/core/CLAUDE.md');
    expect(paths.some((path) => path.startsWith('docs/plans/'))).toBe(false);
  });
});
