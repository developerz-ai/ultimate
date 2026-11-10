#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that the root README's facts table is the tree's: the
// package count, the gate's steps, the coverage bar and its pins, the test files and the `X_*`
// codes, each read off disk and written into a generated block with the command that re-derives it.
//
//   bun run scripts/readme-facts.ts [--write] [--json]

import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import { flagBool, parseScriptArgs } from './lib/args';
import { COVERAGE_PINS, COVERAGE_TARGET } from './lib/coverage-pins';
import { fillGenerated, readGenerated } from './lib/generated-block';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces } from './lib/workspaces';

const SCRIPT = 'readme-facts';
const BLOCK = 'readme-facts';
const CODE = 'X_README_FACTS_DRIFT';
export const README_FILE = 'README.md';
export const README_FACTS_FIX = 'bun run scripts/readme-facts.ts --write';

/**
 * Two counts are FLOORED to the hundred and written "N+": every new test file or code would
 * otherwise red the gate on an unrelated pull request, and a guard that fires on every diff is one
 * its readers learn to `--write` without reading. "3,800+" stays true until the next hundred.
 */
const ROUND = 100;
const TEST_GLOBS = ['packages/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'] as const;
const MANIFEST = 'framework.manifest.json';

export interface CoverageUnitPin {
  readonly unit: string;
  readonly lines: number;
  readonly funcs: number;
}

export interface ReadmeFacts {
  /** Publishable workspaces — every one versions and publishes in lockstep. */
  readonly packages: number;
  readonly steps: number;
  readonly coverageTarget: number;
  /** Units allowed under the target today, each with its floor. */
  readonly coveragePins: readonly CoverageUnitPin[];
  readonly testFiles: number;
  readonly codes: number;
}

export const floorTo = (value: number, step: number): string =>
  value < step ? String(value) : `${(Math.floor(value / step) * step).toLocaleString('en-US')}+`;

const coverageCell = (facts: ReadmeFacts): string => {
  const pins = facts.coveragePins.map(
    (pin) => `\`${pin.unit}/\` pinned at ${pin.lines}% / ${pin.funcs}%`,
  );
  return [`≥ ${facts.coverageTarget}% lines and functions`, ...pins].join('; ');
};

/** The table, header included. Rows only change when a fact does. */
export function renderReadmeFacts(facts: ReadmeFacts): readonly string[] {
  return [
    '| Fact | Today | Re-derive it |',
    '|---|---|---|',
    `| packages, versioned and published in lockstep | ${facts.packages} | \`bun run scripts/list-workspaces.ts --json\` |`,
    `| steps in the gate, \`x verify\` | ${facts.steps} | \`bun run x -- verify --json\` |`,
    `| coverage, per package and \`create-ultimate\` | ${coverageCell(facts)} | \`bun run coverage\` |`,
    `| test files beside their source | ${floorTo(facts.testFiles, ROUND)} | \`git ls-files '*.test.ts' '*.test.tsx' \\| grep -cE '^(packages\\|scripts)/'\` |`,
    `| \`X_*\` codes, each with a cause and a \`fix:\` | ${floorTo(facts.codes, ROUND)} | \`jq '.errorCodes \\| length' ${MANIFEST}\` |`,
  ];
}

const countTestFiles = (root: string): number => {
  let count = 0;
  for (const glob of TEST_GLOBS) {
    for (const path of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true })) {
      if (!path.split(/[\\/]/).includes('node_modules')) count += 1;
    }
  }
  return count;
};

const countCodes = async (root: string): Promise<number> => {
  const handle = Bun.file(`${root}/${MANIFEST}`);
  if (!(await handle.exists())) return 0;
  const parsed: unknown = await handle.json();
  if (typeof parsed !== 'object' || parsed === null || !('errorCodes' in parsed)) return 0;
  const codes = parsed.errorCodes;
  return Array.isArray(codes) ? codes.length : 0;
};

/** Every fact, read off the tree under `root`. */
export async function readReadmeFacts(root: string): Promise<ReadmeFacts> {
  const workspaces = await listWorkspaces(root);
  return {
    packages: workspaces.filter((workspace) => !workspace.private).length,
    steps: VERIFY_STEP_NAMES.length,
    coverageTarget: COVERAGE_TARGET,
    coveragePins: Object.entries(COVERAGE_PINS).map(([unit, pin]) => ({
      unit,
      lines: pin.lines,
      funcs: pin.funcs,
    })),
    testFiles: countTestFiles(root),
    codes: await countCodes(root),
  };
}

/** Drift: the block is missing, or is not what the facts render. */
export function checkReadmeFacts(markdown: string, facts: ReadmeFacts): readonly Finding[] {
  const body = readGenerated(markdown, BLOCK, README_FACTS_FIX);
  if (body === undefined) {
    return [
      {
        code: CODE,
        cause: `${README_FILE} has no generated readme-facts block, so the facts it states are a hand-copy nothing checks`,
        fix: `grep -n '^| Claim |' ${README_FILE}   # under that table put the lines "<!-- generated: ${BLOCK} — ${README_FACTS_FIX} -->" and "<!-- end generated -->", then: ${README_FACTS_FIX}`,
        at: README_FILE,
      },
    ];
  }
  if (body.join('\n') === renderReadmeFacts(facts).join('\n')) return [];
  return [
    {
      code: CODE,
      cause: `${README_FILE}'s facts table is not what the tree says now: a package, a gate step, a coverage pin, or a hundred tests or codes moved`,
      fix: README_FACTS_FIX,
      at: README_FILE,
    },
  ];
}

/** The README with its block rewritten; one with no block is returned as it was. */
export const writeReadmeFacts = (markdown: string, facts: ReadmeFacts): string =>
  fillGenerated(markdown, BLOCK, README_FACTS_FIX, renderReadmeFacts(facts)) ?? markdown;

/** A root with no README makes no facts claim — a fixture tree, never this repository's. */
export async function readmeFactsFindings(root: string): Promise<readonly Finding[]> {
  const readme = Bun.file(`${root}/${README_FILE}`);
  if (!(await readme.exists())) return [];
  return checkReadmeFacts(await readme.text(), await readReadmeFacts(root));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const facts = await readReadmeFacts(root);
  if (flagBool(args, 'write')) {
    const handle = Bun.file(`${root}/${README_FILE}`);
    await Bun.write(handle, writeReadmeFacts(await handle.text(), facts));
  }
  const findings = await readmeFactsFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${README_FILE}'s facts table is the tree's`
          : `${README_FILE}'s facts table differs from the tree`,
      findings,
      data: facts,
    },
    args.json,
  );
}
