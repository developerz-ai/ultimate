#!/usr/bin/env bun
// Enforce, on a scratch scaffold built from this checkout, that tutorials 1–4 run as written: each
// `bash` fence in page order, and the `✓`/`✗` summary line of the `text` fence after it is a line
// the run printed. A tutorial nobody runs drifts a line at a time — Tutorial 2, run command by
// command on 2026-11-02, did not end green, and every guard in this repo read it as prose.
//
// WHAT RUNS: every bash fence, in one shell session per fence that carries its directory to the
// next, except one marked `<!-- no-run: why -->` on the line above (a server that runs until
// stopped, a step needing Docker). `…` in an expected line is the page marking that span variable
// — a timing, a timestamp; every other character is held literally. A fence is held to its exit
// code too: zero, unless the page's own summary for it starts with `✗`.
//
// THE ONE SUBSTITUTION: `bunx create-ultimate` runs this checkout's `create-ultimate`, then points
// the new app's `@ultimat3/*` ranges at `packages/*` (`scaffold-smoke-overrides.ts`), so the run
// proves this tree rather than the last published release.
//
// NOT IN `ci`: its own workflow, `.github/workflows/tutorial-run.yml`, on a push to `main` touching
// a tutorial or a generator. It installs and gates a scaffold several times; ci's clock does not pay.
//
//   bun run scripts/tutorial-run.ts [--json]

// why: a scratch directory for the run to start in; Bun has no temporary-directory or path API.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { LONG_RUN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import type { TutorialStep } from './lib/tutorial-steps';
import { matchesSummary, summaryLines, tutorialSteps } from './lib/tutorial-steps';

const SCRIPT = 'tutorial-run';
const RERUN = 'bun run scripts/tutorial-run.ts --json';
const CWD_MARK = '__TUTORIAL_RUN_CWD__';

/** The pages, in the order a reader takes them: each starts in the app the one before it left. */
export const TUTORIALS: readonly string[] = [
  'wiki/Tutorial-01-First-App.md',
  'wiki/Tutorial-02-First-Feature.md',
  'wiki/Tutorial-03-Auth-And-Admin.md',
  'wiki/Tutorial-04-Jobs-And-Realtime.md',
];

/** A fresh machine's environment: no service a tutorial says it never needs locally. */
const UNSET = ['DATABASE_URL', 'NATS_URL', 'REDIS_URL', 'S3_ENDPOINT'];

export interface StepRun {
  readonly code: number | null;
  readonly output: string;
  /** The directory the fence left the shell in: the next fence starts there. */
  readonly cwd: string;
}

export type Execute = (command: string, cwd: string) => Promise<StepRun>;

/** `bunx create-ultimate <name> …` as this checkout's generator, with the app pointed at `packages/*`. */
export function fromCheckout(command: string, root: string): string {
  return command.replace(/\bbunx create-ultimate\b([^\n;&|]*)/g, (_whole, rest: string) => {
    const name = rest.split(/\s+/).find((arg) => arg !== '' && !arg.startsWith('-')) ?? 'myapp';
    const created = `"$PWD/${name}"`;
    return `bun "${root}/packages/create-ultimate/src/bin.ts"${rest} && ( app=${created}; cd "${root}" && bun scripts/scaffold-smoke-overrides.ts "$app" )`;
  });
}

/** The real shell: one `bash` per fence, its final directory read back through an EXIT trap. */
export const shellExecute =
  (root: string): Execute =>
  async (command, cwd) => {
    const script = [
      `trap 'printf "\\n${CWD_MARK}%s\\n" "$PWD"' EXIT`,
      'set -eo pipefail',
      fromCheckout(command, root),
    ].join('\n');
    const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !UNSET.includes(key)));
    const result = await run(['bash', '-c', script], { cwd, timeoutMs: LONG_RUN_TIMEOUT_MS, env });
    const marked = result.output.split('\n').findLast((line) => line.startsWith(CWD_MARK));
    return {
      code: result.code,
      output: result.output
        .split('\n')
        .filter((line) => !line.startsWith(CWD_MARK))
        .join('\n')
        .trimEnd(),
      cwd: marked === undefined ? cwd : marked.slice(CWD_MARK.length),
    };
  };

/** Why one run is not what its page says, or `undefined` when it is. */
export function divergence(step: TutorialStep, ran: StepRun): string | undefined {
  const printed = summaryLines(ran.output);
  const missing = step.expected.filter((line) => !matchesSummary(line, printed));
  if (missing.length > 0) {
    const shown = printed.length === 0 ? 'no ✓/✗ line' : printed.slice(-3).join(' | ');
    return `the page shows "${missing[0]}", and the run printed ${shown}`;
  }
  const failing = step.expected.some((line) => line.startsWith('✗'));
  if (ran.code !== 0 && !failing) {
    const tail = ran.output.trim().split('\n').slice(-3).join(' | ');
    return `it exited ${String(ran.code)} where the page shows it succeeding: ${tail}`;
  }
  return undefined;
}

export interface TutorialReport {
  readonly findings: readonly Finding[];
  readonly ran: number;
  readonly skipped: readonly string[];
}

/** Every page's steps in order, stopping at the first that diverges: the rest ran on its state. */
export async function runTutorials(
  pages: readonly { readonly path: string; readonly text: string }[],
  execute: Execute,
  start: string,
): Promise<TutorialReport> {
  const steps = pages.flatMap((page) => tutorialSteps(page.path, page.text));
  if (steps.length === 0) {
    return {
      findings: [
        {
          code: 'X_CORPUS_UNSCANNED',
          cause: `no \`\`\`bash fence in ${TUTORIALS.join(', ')}, so ${SCRIPT} ran nothing and reported green`,
          fix: `${RERUN}   # run it from the repository root, and keep each tutorial's commands in \`\`\`bash fences`,
          at: TUTORIALS[0] ?? 'wiki/',
        },
      ],
      ran: 0,
      skipped: [],
    };
  }
  let cwd = start;
  let ran = 0;
  const skipped: string[] = [];
  for (const step of steps) {
    const at = `${step.path}:${String(step.line)}`;
    if (step.skip !== undefined) {
      skipped.push(`${at} (${step.skip})`);
      continue;
    }
    const result = await execute(step.command, cwd);
    ran += 1;
    const why = divergence(step, result);
    if (why !== undefined) {
      const finding: Finding = {
        code: 'X_DOC_TUTORIAL_DIVERGED',
        cause: `${at} runs \`${step.command.split('\n')[0] ?? ''}\`, and ${why} — the ${String(steps.length - ran - skipped.length)} step(s) after it were not run`,
        fix: `${RERUN}   # then edit ${at} and the text fence below it to what the run printed, or fix the generator or command that printed it`,
        at,
      };
      return { findings: [finding], ran, skipped };
    }
    cwd = result.cwd;
  }
  return { findings: [], ran, skipped };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const pages = await Promise.all(
    TUTORIALS.map(async (path) => ({ path, text: await Bun.file(join(root, path)).text() })),
  );
  const start = await mkdtemp(join(tmpdir(), 'tutorial-run-'));
  // Removed before the report: `report` exits the process, so a `finally` after it never runs.
  const outcome = await runTutorials(pages, shellExecute(root), start).finally(() =>
    rm(start, { recursive: true, force: true }),
  );
  report(
    {
      ok: outcome.findings.length === 0,
      script: SCRIPT,
      summary:
        outcome.findings.length === 0
          ? `tutorials 1–4 ran as written: ${String(outcome.ran)} step(s), ${String(outcome.skipped.length)} marked no-run`
          : `a tutorial diverged after ${String(outcome.ran)} step(s)`,
      findings: outcome.findings,
      lines: outcome.skipped.map((one) => `  no-run   ${one}`),
      data: { ran: outcome.ran, skipped: outcome.skipped },
    },
    args.json,
  );
}
