// The rule that keeps tests and root docs out of every build context, judged line by line and then
// against the real tree: an ignore file in this repo and the one `x new` writes must both pass it.

import { describe, expect, test } from 'bun:test';
import { names } from '../../packages/cli/src/templates/naming';
import { containerFiles } from '../../packages/cli/src/templates/scaffold-container';
import { imageContractFindings } from '../image-contract';
import {
  CONTENT_IGNORE_LINES,
  checkContentIgnores,
  contentGapFindingFor,
  unignoredContentOf,
} from './image-content-ignores';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

const COMPLETE = ['node_modules', ...CONTENT_IGNORE_LINES, ''].join('\n');

describe('what an ignore file must say', () => {
  test('the three lines are the slice’s, and all three present is clean', () => {
    expect(CONTENT_IGNORE_LINES).toEqual(['**/*.test.ts', '**/*.test.tsx', 'docs']);
    expect(unignoredContentOf(COMPLETE)).toEqual([]);
  });

  test('each missing line is named, on its own', () => {
    for (const line of CONTENT_IGNORE_LINES) {
      const text = COMPLETE.split('\n')
        .filter((one) => one !== line)
        .join('\n');
      expect(unignoredContentOf(text)).toEqual([line]);
    }
  });

  test('a commented-out line and a recursive docs are not the rule', () => {
    const commented = COMPLETE.replace('\ndocs\n', '\n# docs\n');
    expect(unignoredContentOf(commented)).toEqual(['docs']);
    // `**/docs` drops a package's run-time directory of that name: a stricter-looking rule that
    // fails at boot, and the reason this line is anchored.
    const recursive = COMPLETE.replace('\ndocs\n', '\n**/docs\n');
    expect(unignoredContentOf(recursive)).toEqual(['docs']);
  });

  test('a re-include of one file is the documented escape, not a gap', () => {
    expect(unignoredContentOf(`${COMPLETE}!docs/mcp/tools.md\n`)).toEqual([]);
    expect(unignoredContentOf(`${COMPLETE}!apps/web/keep.test.ts\n`)).toEqual([]);
  });

  test('a re-include of the whole class undoes the line, and order decides', () => {
    expect(unignoredContentOf(`${COMPLETE}!docs\n`)).toEqual(['docs']);
    expect(unignoredContentOf(`${COMPLETE}!docs/**\n`)).toEqual(['docs']);
    expect(unignoredContentOf(`${COMPLETE}!/docs\n`)).toEqual(['docs']);
    expect(unignoredContentOf(`${COMPLETE}!**/*.test.tsx\n`)).toEqual(['**/*.test.tsx']);
    expect(unignoredContentOf(`${COMPLETE}!**\n`)).toEqual([...CONTENT_IGNORE_LINES]);
    expect(unignoredContentOf(`!docs\n${COMPLETE}`)).toEqual([]);
  });

  test('a glob re-include under any directory undoes the line, wherever it points', () => {
    expect(unignoredContentOf(`${COMPLETE}!packages/**/*.test.ts\n`)).toEqual(['**/*.test.ts']);
    expect(unignoredContentOf(`${COMPLETE}!apps/*/x.test.tsx\n`)).toEqual(['**/*.test.tsx']);
    expect(unignoredContentOf(`${COMPLETE}!docs/mcp/*.md\n`)).toEqual(['docs']);
    // A glob that cannot reach the class is not a re-include of it.
    expect(unignoredContentOf(`${COMPLETE}!packages/**/*.md\n`)).toEqual([]);
  });
});

describe('the finding', () => {
  test('names the file and every missing line, with a fix to paste', () => {
    const file = 'apps/edge/Dockerfile.dockerignore';
    const gaps = checkContentIgnores([{ file, text: 'node_modules\n**/*.test.ts\n' }]);
    expect(gaps).toEqual([{ file, missing: ['**/*.test.tsx', 'docs'] }]);
    const finding = contentGapFindingFor(gaps[0] ?? { file: '', missing: [] });
    expect(finding.code).toBe('X_IMAGE_CONTENT_UNIGNORED');
    expect(finding.at).toBe(file);
    expect(finding.cause).toContain('**/*.test.tsx');
    expect(finding.fix).toContain('**/*.test.tsx');
    expect(finding.fix).toContain(file);
    expect(finding.fix).toContain('bun run scripts/image-contract.ts --json');
    expect(finding.fix).not.toContain("'**/*.test.ts'");
  });
});

describe('the rule and what it judges agree', () => {
  test('the ignore file `x new` writes passes it', () => {
    const file = containerFiles(names('my-app')).find(
      (one) => one.path === 'docker/Dockerfile.dockerignore',
    );
    if (typeof file?.contents !== 'string') return expect.unreachable('no generated ignore file');
    expect(unignoredContentOf(file.contents)).toEqual([]);
  });

  test(
    'every ignore file in this tree passes it',
    async () => {
      const found = await imageContractFindings(repoRoot());
      expect(found.filter((one) => one.code === 'X_IMAGE_CONTENT_UNIGNORED')).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
