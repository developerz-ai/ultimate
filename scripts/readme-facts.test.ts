// The README's facts table and the tree it describes: every negative case is a fixture README and a
// fixture fact set, never an edit to README.md, which other suites read while this one runs.

import { describe, expect, test } from 'bun:test';
import { GENERATED_CLOSE, generatedOpen } from './lib/generated-block';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { ReadmeFacts } from './readme-facts';
import {
  checkReadmeFacts,
  floorTo,
  README_FACTS_FIX,
  readmeFactsFindings,
  readReadmeFacts,
  renderReadmeFacts,
  writeReadmeFacts,
} from './readme-facts';

const FACTS: ReadmeFacts = {
  packages: 31,
  steps: 21,
  coverageTarget: 95,
  coveragePins: [{ unit: 'scripts', lines: 83, funcs: 89 }],
  testFiles: 3812,
  codes: 1229,
};

const readme = (body: readonly string[]): string =>
  ['# Title', generatedOpen('readme-facts', README_FACTS_FIX), ...body, GENERATED_CLOSE, ''].join(
    '\n',
  );

describe('floorTo', () => {
  test('rounds DOWN, so "N+" stays true until the next hundred', () => {
    expect(floorTo(3812, 100)).toBe('3,800+');
    expect(floorTo(3800, 100)).toBe('3,800+');
    expect(floorTo(99, 100)).toBe('99');
  });
});

describe('renderReadmeFacts', () => {
  test('one row per fact, each with the command that re-derives it', () => {
    const rows = renderReadmeFacts(FACTS).filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Fact'),
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toMatch(/`[^`]+`\s*\|$/);
  });

  test('a pin below the target is stated beside it, never hidden', () => {
    expect(renderReadmeFacts(FACTS).join('\n')).toContain('`scripts/` pinned at 83% / 89%');
    const none = renderReadmeFacts({ ...FACTS, coveragePins: [] }).join('\n');
    expect(none).not.toContain('pinned');
  });
});

describe('checkReadmeFacts', () => {
  test('the rendered block is green', () => {
    expect(checkReadmeFacts(readme(renderReadmeFacts(FACTS)), FACTS)).toEqual([]);
  });

  test('a fact the tree moved reds with the --write fix', () => {
    const stale = readme(renderReadmeFacts({ ...FACTS, packages: 30 }));
    const [finding] = checkReadmeFacts(stale, FACTS);
    expect(finding?.code).toBe('X_README_FACTS_DRIFT');
    expect(finding?.fix).toBe(README_FACTS_FIX);
  });

  test('a test count inside the same hundred is not drift', () => {
    const block = readme(renderReadmeFacts({ ...FACTS, testFiles: 3899 }));
    expect(checkReadmeFacts(block, FACTS)).toEqual([]);
  });

  test('a README with no block reds: a facts table nothing generates is a hand-copy', () => {
    const [finding] = checkReadmeFacts('# Title\n', FACTS);
    expect(finding?.code).toBe('X_README_FACTS_DRIFT');
    expect(finding?.cause).toContain('no generated readme-facts block');
  });

  test('--write repairs the drift it reports', () => {
    const fixed = writeReadmeFacts(readme(['stale']), FACTS);
    expect(checkReadmeFacts(fixed, FACTS)).toEqual([]);
  });
});

describe('this repository', () => {
  test(
    'the facts are read off the tree, not restated',
    async () => {
      const facts = await readReadmeFacts(repoRoot());
      expect(facts.packages).toBeGreaterThan(20);
      expect(facts.steps).toBeGreaterThan(15);
      expect(facts.testFiles).toBeGreaterThan(1000);
      expect(facts.codes).toBeGreaterThan(500);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    "README.md's block is what the tree says",
    async () => {
      expect(await readmeFactsFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
