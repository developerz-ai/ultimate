// `tutorial-steps.ts`: which fences a tutorial runs, what each one's output must say, and how a
// printed line is held to it.

import { describe, expect, test } from 'bun:test';
import { matchesSummary, summaryLines, tutorialSteps } from './tutorial-steps';

const PAGE = [
  '# T',
  '',
  '```bash',
  'bunx x g resource todo --dry-run',
  '```',
  '',
  '```text',
  '  + apps/web/app/todo/entity.ts',
  '✓ would write 38 file(s) for resource todo — nothing written',
  '```',
  '',
  '<!-- no-run: serves until stopped -->',
  '```bash',
  'bunx x dev',
  '```',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '```text',
  '✓ not this fence’s output',
  '```',
  '',
  '```bash',
  'bunx x verify',
  '```',
].join('\n');

describe('tutorialSteps', () => {
  test('every bash fence in order, its line, and the summary of the text fence right after it', () => {
    const steps = tutorialSteps('wiki/T.md', PAGE);
    expect(steps.map((step) => [step.line, step.command, step.skip, step.expected])).toEqual([
      [
        3,
        'bunx x g resource todo --dry-run',
        undefined,
        ['✓ would write 38 file(s) for resource todo — nothing written'],
      ],
      [13, 'bunx x dev', 'serves until stopped', []],
      [25, 'bunx x verify', undefined, []],
    ]);
  });

  test('a no-run marker with no reason is not a marker: the reason is the point', () => {
    const page = '<!-- no-run: -->\n```bash\nbunx x dev\n```';
    expect(tutorialSteps('wiki/T.md', page)[0]?.skip).toBeUndefined();
  });
});

describe('summaryLines', () => {
  test('a summary is an unindented ✓ or ✗ line; an indented step line is not', () => {
    expect(summaryLines('  ✓ typecheck\n  ✗ budgets\n✗ 1 of 20 steps failed\nnoise')).toEqual([
      '✗ 1 of 20 steps failed',
    ]);
  });

  test('colour codes and trailing space are not part of the line', () => {
    expect(summaryLines('\u001b[32m✓\u001b[0m done  \n')).toEqual(['✓ done']);
  });
});

describe('matchesSummary', () => {
  test('a literal line matches only itself', () => {
    expect(matchesSummary('✓ would write 38 file(s)', ['✓ would write 38 file(s)'])).toBe(true);
    expect(matchesSummary('✓ would write 33 file(s)', ['✓ would write 38 file(s)'])).toBe(false);
  });

  test('… is where the page marks a span variable, and only there', () => {
    const expected = '✓ 19 of 20 steps passed in …ms — 1 skipped: roadmap';
    expect(
      matchesSummary(expected, ['✓ 19 of 20 steps passed in 6911ms — 1 skipped: roadmap']),
    ).toBe(true);
    expect(
      matchesSummary(expected, ['✓ 18 of 20 steps passed in 6911ms — 1 skipped: roadmap']),
    ).toBe(false);
  });

  test('regex syntax in the page is literal text', () => {
    expect(matchesSummary('✓ a (b) [c]', ['✓ a (b) [c]'])).toBe(true);
    expect(matchesSummary('✓ a.b', ['✓ axb'])).toBe(false);
  });
});
