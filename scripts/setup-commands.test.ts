// The six-step `bin/setup` sequence is hand-copied into four pages and derived by nobody, which is
// how `x db seed` sat in the script with no CI path running it and no page obliged to mention it.
// These pin that the list comes out of the template's own bytes, that a page can be stale in both
// directions, and that neither half of the rule can go quietly vacuous.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { MarkdownFile } from './lib/doc-citations';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkSetupCommands,
  countClaims,
  ENUMERATION_MIN,
  SETUP_TEMPLATE,
  setupCommandGaps,
  setupSteps,
  skipSetupPath,
  stepRows,
} from './setup-commands';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const TEMPLATE = `const binSetup = (): string => \`#!/usr/bin/env bash
# Fresh clone to running. Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "X_BUN_MISSING: install bun"; exit 1; }
bun install
[ -f .env.development.local ] || printf '# wins over .env.development\\\\n' > .env.development.local
ls packages/db/migrations/*.sql >/dev/null 2>&1 || bunx x db gen "initial"
bunx x db migrate "$@"
bunx x db seed
bunx x manifest
echo "setup complete — next: bin/dev"
\`;
`;

const STEPS = setupSteps(TEMPLATE);

const page = (path: string, text: string): MarkdownFile => ({ path, text }) as MarkdownFile;

const ROWS = [
  '| # | Step | Why |',
  '|---|---|---|',
  '| 1 | `bun install` | writes files and installs nothing |',
  '| 2 | touch `.env.development.local` | per-box secrets |',
  '| 3 | `x db gen "initial"` | the only writer of that directory |',
  '| 4 | `x db migrate` | applies them |',
  '| 5 | `x db seed` | through the CLI, never bun run |',
  '| 6 | `x manifest` | a projection of the loaded app |',
];

const tablePage = (
  rows: readonly string[] = ROWS,
  lead = '`bin/setup` is six steps:',
): MarkdownFile => page('wiki/Installation.md', [lead, '', ...rows].join('\n'));

describe('unit · setupSteps reads the script, never a list kept here', () => {
  test('derives the sequence in script order, by the name a page writes', () => {
    expect(STEPS.map((step) => step.id)).toEqual([
      'bun install',
      '.env.development.local',
      'x db gen',
      'x db migrate',
      'x db seed',
      'x manifest',
    ]);
  });

  /**
   * The guard is not a step: `ls … || bunx x db gen "initial"` is the `x db gen` step and the `ls`
   * is why re-running the script is safe. Counting the guard would make the documented six a seven
   * no page has ever written.
   */
  test('a guarded command is one step, and the preamble is none', () => {
    expect(STEPS.filter((step) => step.id === 'x db gen')).toHaveLength(1);
    expect(STEPS.map((step) => step.id)).not.toContain('command');
    expect(STEPS.map((step) => step.id)).not.toContain('echo');
  });

  // The env step writes the per-box file; the committed one is named inside the printf body, and
  // taking the first match named that instead.
  test('the env step is the file it writes, not the file its comment mentions', () => {
    expect(STEPS[1]?.id).toBe('.env.development.local');
  });

  test('a template this reader cannot parse yields no steps, which is its own finding', () => {
    expect(setupSteps('export const nothing = 1;')).toEqual([]);
    const gaps = checkSetupCommands({ pages: [tablePage()], steps: [] });
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(gaps[0]?.at).toBe(SETUP_TEMPLATE);
  });
});

describe('unit · the count rule', () => {
  test('a page stating the script’s own count is silent', () => {
    expect(checkSetupCommands({ pages: [tablePage()], steps: STEPS })).toEqual([]);
  });

  test('a count that is not the script’s names both numbers', () => {
    const gaps = checkSetupCommands({
      pages: [tablePage(ROWS, '`bin/setup` is five steps:')],
      steps: STEPS,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['count']);
    expect(gaps[0]?.detail).toBe('says bin/setup is 5 steps and the script runs 6');
    expect(gaps[0]?.at).toBe('wiki/Installation.md:1');
  });

  /**
   * The other thing this corpus counts in steps is the gate, and four pages say "20 steps" on a
   * line that also mentions `bin/setup`. `scripts/gate-steps.ts` owns that number.
   */
  test('a gate step count on the same line belongs to the other rule', () => {
    expect(countClaims('`bin/setup` then `bin/check` — the gate is 20 steps')).toEqual([]);
    expect(countClaims('`x verify` runs 20 steps, and `bin/setup` precedes it')).toEqual([]);
    expect(countClaims('`bin/setup` is six steps')).toEqual([6]);
  });

  test('a count on a line that never mentions the script is not its claim', () => {
    expect(countClaims('the tutorial is four steps long')).toEqual([]);
  });

  // The number table is a Record read by a word taken off a documentation line, so an inherited
  // member is reachable: `NUMBER_WORDS['constructor']` is a function, and a function is not
  // `undefined`. `bun run scripts/proto-index.ts` is the rule; this is the case.
  test('a word that is an Object.prototype member counts as nothing', () => {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(countClaims(`\`bin/setup\` is ${word} steps`), word).toEqual([]);
    }
  });
});

describe('unit · the list rule', () => {
  test('a row-led table missing a step names the step, not the row count', () => {
    const gaps = checkSetupCommands({
      pages: [tablePage(ROWS.filter((row) => !row.includes('x db seed')))],
      steps: STEPS,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['missing']);
    expect(gaps[0]?.detail).toContain('the script also runs x db seed');
  });

  /**
   * Prose is deliberately out of scope: `wiki/FAQ.md` writes "the first migration generated and
   * applied, the seed", which is correct English, and a rule that demanded the command spelling in
   * a sentence would report prose that is right.
   */
  test('a sentence paraphrasing the steps is not judged as a list', () => {
    const prose = page(
      'wiki/FAQ.md',
      '`bin/setup` is six steps — `bun install`, an `.env.development.local` touch, the first migration generated and applied, the seed, and `x manifest`.',
    );
    expect(checkSetupCommands({ pages: [prose, tablePage()], steps: STEPS })).toEqual([]);
  });

  test('fewer than three step rows is a mention, not an enumeration', () => {
    const two = ROWS.filter((row) => /`bun install`|`x manifest`|#|---/.test(row));
    expect(stepRows(two, STEPS)).toHaveLength(2);
    expect(ENUMERATION_MIN).toBeGreaterThan(2);
  });

  test('CONTRIBUTING.md documents this repo’s own bin/setup and is left alone', () => {
    expect(skipSetupPath('CONTRIBUTING.md')).toBe(true);
    expect(skipSetupPath('wiki/Installation.md')).toBe(false);
  });
});

/**
 * Both halves can stop matching on their own — a table rewritten as prose silences the list rule
 * while the count rule still works, and each would then report green forever.
 */
describe('unit · neither half may go vacuous', () => {
  test('no row-led list anywhere is a finding', () => {
    const gaps = checkSetupCommands({
      pages: [page('wiki/FAQ.md', '`bin/setup` is six steps.')],
      steps: STEPS,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(gaps[0]?.detail).toContain('the list rule read nothing');
  });

  test('no count anywhere is a finding', () => {
    const gaps = checkSetupCommands({
      pages: [tablePage(ROWS, '`bin/setup` runs:')],
      steps: STEPS,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(gaps[0]?.detail).toContain('the count rule read nothing');
  });
});

/**
 * The shipped call, against the real corpus and the real template. Without this every test above
 * could agree with a rule the repository never runs — and a green here is the claim the PR makes.
 */
test('the repository’s own pages match the bin/setup this scaffold writes', async () => {
  const root = repoRoot();
  expect(setupSteps(await Bun.file(`${root}/${SETUP_TEMPLATE}`).text()).map((s) => s.id)).toEqual(
    STEPS.map((step) => step.id),
  );
  expect(await setupCommandGaps(root)).toEqual([]);
});
