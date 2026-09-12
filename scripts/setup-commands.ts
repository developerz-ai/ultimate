#!/usr/bin/env bun
// Enforce, as a gate step, that every page enumerating what a scaffolded app's `bin/setup` runs
// enumerates the script `x new` actually writes. The list is DERIVED from the template that emits
// it (`packages/cli/src/templates/scaffold-docs.ts`, `binSetup`), never restated here, so a step
// added to or removed from that script makes the prose red on the same commit.
//
// The gap this closes: the six-step list is hand-copied into four pages — `wiki/Installation.md`
// as a numbered table, `wiki/Getting-Started.md` and `wiki/Tutorial-01-First-App.md` as prose,
// `wiki/Bare-VM.md` as a table cell — and `x db seed` had to be ADDED to that script's documented
// sequence in this very PR. A list copied into four files goes stale in three of them, and until
// now nothing compared any of them to the script. `scripts/gate-steps.ts` is the same shape of rule
// over the same corpus, for the same reason.
//
// TWO RULES, because a page can be stale in two ways and the fixes differ. The COUNT is wrong when
// a step is added or dropped ("six steps"). The LIST is wrong when a step is replaced or renamed —
// and a list can be wrong while its own count is right, which is the failure a count check alone
// would wave through.
//
// What it deliberately does NOT do: report a command the block names that `bin/setup` does not run.
// Those pages legitimately name neighbouring commands while explaining a step — `wiki/Installation.md`'s
// sixth row cites `x verify`'s `manifest` step to say why `x manifest` is in the script — so that
// rule would report prose that is correct. Stated rather than papered over.
//
//   bun run scripts/setup-commands.ts [--json]

import { readDocPages } from './doc-commands';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'setup-commands';

/** The template that writes the scaffold's `bin/setup`, and the only source of the list. */
export const SETUP_TEMPLATE = 'packages/cli/src/templates/scaffold-docs.ts';

/**
 * `CONTRIBUTING.md` documents THIS repository's `bin/setup` — `scripts/setup.ts`, which checks the
 * Bun version, installs and writes git hooks. Same filename, different script, and holding a page
 * about one to the other's step list is a finding on a sentence that is right.
 */
export const skipSetupPath = (path: string): boolean => path === 'CONTRIBUTING.md';

/**
 * Lines of `binSetup()` that run something but are not one of its STEPS: the interpreter line, the
 * shell options, the `cd` into the app root, the Bun precondition (a refusal, not a step — the
 * pages that enumerate the script all start at `bun install`) and the closing `echo`. Five names,
 * listed rather than inferred, so a sixth arriving in the template shows up as a changed count
 * here and a human decides which it is.
 */
const PREAMBLE = [/^set\s/, /^cd\s/, /^command -v\s/, /^echo\s/, /^#!/];

/** One thing `bin/setup` does, in script order, named the way a page names it. */
export interface SetupStep {
  /** How prose cites it: `bun install`, `x db migrate`, `.env.development.local`. */
  readonly id: string;
  /** The template line it was derived from, so a finding can show the script's own bytes. */
  readonly line: string;
}

/** The body of `binSetup()` — everything between its backtick-quoted template literal. */
export const setupBody = (template: string): string | undefined =>
  template.match(/const binSetup = \(\): string => `([\s\S]*?)`;\n/)?.[1];

/**
 * The steps, in the order the script runs them. `||` guards are unwrapped to the command they
 * guard: `ls packages/db/migrations/*.sql >/dev/null 2>&1 || bunx x db gen "initial"` IS the
 * `x db gen` step, and the guard is why it is idempotent rather than a step of its own.
 */
export function setupSteps(template: string): readonly SetupStep[] {
  const body = setupBody(template);
  if (body === undefined) return [];
  const steps: SetupStep[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (PREAMBLE.some((pattern) => pattern.test(line))) continue;
    // The guarded half is the step; an unguarded line is its own.
    const command = (line.split('||').at(-1) ?? line).trim();
    const x = command.match(/bunx x ([a-z]+(?: [a-z]+)?)/);
    if (x?.[1] !== undefined) {
      steps.push({ id: `x ${x[1]}`, line });
      continue;
    }
    if (command.startsWith('bun install')) {
      steps.push({ id: 'bun install', line });
      continue;
    }
    // The LAST `.env…` on the line, which is the redirect target. The first one is inside the
    // `printf` body — "wins over .env.development" — so taking it named the committed file rather
    // than the per-box one the step actually writes.
    const env = [...command.matchAll(/(\.env\.[a-z.]+)/g)].at(-1);
    if (env?.[1] !== undefined) {
      steps.push({ id: env[1], line });
      continue;
    }
    steps.push({ id: command.split(' ')[0] ?? command, line });
  }
  return steps;
}

/**
 * A ROW-LED enumeration: a table or list inside the block whose rows each name one step. That is
 * the shape the list rule judges, and prose is deliberately out of scope — `wiki/FAQ.md` writes
 * "the first migration generated and applied, the seed" and `wiki/Tutorial-01-First-App.md` writes
 * "the seed" for `x db seed`, both correct English, and a rule that demanded the command spelling
 * in a sentence would report prose that is right. A page that lays the script out as rows is
 * presenting itself as the list, and a renamed step there is invisible to every other check.
 */
export const ENUMERATION_MIN = 3;

/** A block may not run away: a page-long scan would read a whole chapter as one list. */
const MAX_BLOCK_LINES = 40;

const CONTINUES = /^\s*(\||[-*+]\s|\d+[.)]\s)/;

/**
 * The lines a `bin/setup` mention owns: its own paragraph, plus the table or list it introduces
 * across one blank line. `wiki/Installation.md` states the count in a paragraph and the steps in
 * the numbered table under it, so a line-scoped rule would see a count with no list and a list with
 * no count — two half-claims, neither checkable.
 */
export function blockAt(lines: readonly string[], start: number): readonly string[] {
  const block: string[] = [];
  let index = start;
  while (index < lines.length && block.length < MAX_BLOCK_LINES) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      const next = lines[index + 1] ?? '';
      if (!CONTINUES.test(next)) break;
    } else {
      block.push(line);
    }
    index += 1;
  }
  return block;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * The other thing this corpus counts in steps is the GATE — `x verify` runs 20 of them, and four
 * pages say so on a line that also mentions `bin/setup`. A line naming either the gate or
 * `bin/check` is left to `scripts/gate-steps.ts`, which owns that number; this rule would otherwise
 * report "20 steps" as a wrong answer to a question nobody asked it.
 */
const OTHER_SUBJECT = /x verify|bun run verify|bin\/check|the gate\b|VERIFY_STEP/i;

/** `six steps`, `6 steps` — on a line that is about `bin/setup` and about nothing else countable. */
export function countClaims(line: string): readonly number[] {
  if (!line.includes('bin/setup') || OTHER_SUBJECT.test(line)) return [];
  const claims: number[] = [];
  for (const match of line.matchAll(/\b([a-z]+|\d+)\s+steps\b/gi)) {
    const token = (match[1] ?? '').toLowerCase();
    // `Object.hasOwn` before the read, because the token is a word off a documentation line:
    // "constructor steps" would otherwise answer `Object.prototype.constructor` — a function that
    // is not `undefined` — and push it as a claimed count.
    const word = Object.hasOwn(NUMBER_WORDS, token) ? NUMBER_WORDS[token] : undefined;
    const value = /^\d+$/.test(token) ? Number(token) : word;
    if (value !== undefined) claims.push(value);
  }
  return claims;
}

export type SetupGapKind = 'missing' | 'count' | 'unscanned';

export interface SetupGap {
  readonly kind: SetupGapKind;
  readonly at: string;
  readonly detail: string;
}

export interface SetupCommandInput {
  readonly pages: readonly MarkdownFile[];
  readonly steps: readonly SetupStep[];
}

/** Which of the script's steps a span names. `x db gen "initial"` names `x db gen`. */
export const citedSteps = (text: string, steps: readonly SetupStep[]): readonly string[] =>
  steps.filter((step) => text.includes(step.id)).map((step) => step.id);

/**
 * The rows of a table or list inside the block that each name exactly one step — the shape that
 * presents itself AS the list. One row naming two steps is prose in a cell, not a row per step.
 */
export const stepRows = (
  block: readonly string[],
  steps: readonly SetupStep[],
): readonly string[] =>
  block.filter((line) => CONTINUES.test(line) && citedSteps(line, steps).length === 1);

export function checkSetupCommands(input: SetupCommandInput): readonly SetupGap[] {
  const { pages, steps } = input;
  const expected = steps.map((step) => step.id);
  if (expected.length === 0) {
    return [
      {
        kind: 'unscanned',
        at: SETUP_TEMPLATE,
        detail: `no step could be read out of binSetup() in ${SETUP_TEMPLATE}, so every page below would have been compared against an empty list and reported green`,
      },
    ];
  }
  const gaps: SetupGap[] = [];
  const seen = new Set<string>();
  const push = (gap: SetupGap): void => {
    const key = `${gap.kind} ${gap.at} ${gap.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push(gap);
  };
  let enumerations = 0;
  let counts = 0;
  for (const page of pages) {
    if (skipSetupPath(page.path)) continue;
    const lines = page.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const at = `${page.path}:${String(index + 1)}`;
      // The COUNT is judged on the line that states it, never on the block: the blocks here are
      // tables whose other rows count the GATE's steps, and a block-wide scan read those as claims
      // about this script.
      for (const claimed of countClaims(line)) {
        counts += 1;
        if (claimed === expected.length) continue;
        push({
          kind: 'count',
          at,
          detail: `says bin/setup is ${String(claimed)} steps and the script runs ${String(expected.length)}`,
        });
      }
      if (!line.includes('bin/setup')) continue;
      const rows = stepRows(blockAt(lines, index), steps);
      if (rows.length < ENUMERATION_MIN) continue;
      enumerations += 1;
      const cited = citedSteps(rows.join('\n'), steps);
      const missing = expected.filter((id) => !cited.includes(id));
      if (missing.length > 0) {
        push({
          kind: 'missing',
          at,
          detail: `lays bin/setup out as ${String(rows.length)} rows naming ${cited.join(', ')}, and the script also runs ${missing.join(', ')}`,
        });
      }
    }
  }
  // The vacuity guard every sibling carries, once per rule: a rule whose corpus stopped matching
  // reports green forever, which is worse than the drift it was written for. Both halves have to
  // have read something, because either can stop matching on its own.
  if (enumerations === 0) {
    push({
      kind: 'unscanned',
      at: 'wiki/',
      detail:
        'no page lays bin/setup out as rows, so the list rule read nothing and reported green — check DOC_GLOBS in scripts/doc-commands.ts and stepRows in scripts/setup-commands.ts',
    });
  }
  if (counts === 0) {
    push({
      kind: 'unscanned',
      at: 'wiki/',
      detail:
        'no page states how many steps bin/setup runs, so the count rule read nothing and reported green — check countClaims in scripts/setup-commands.ts',
    });
  }
  return gaps;
}

export const setupCommandFindingFor = (gap: SetupGap, steps: readonly SetupStep[]): Finding =>
  gap.kind === 'unscanned'
    ? {
        code: 'X_DOC_SETUP_COMMANDS_UNSCANNED',
        cause: gap.detail,
        fix: `bun run scripts/setup-commands.ts --json, then widen the corpus or the reader in scripts/setup-commands.ts`,
        at: gap.at,
      }
    : {
        code: 'X_DOC_SETUP_COMMAND_STALE',
        cause: `${gap.at} ${gap.detail}`,
        fix: `make ${gap.at} state bin/setup's own sequence — ${steps.map((step) => step.id).join(', ')} — which is derived from binSetup() in ${SETUP_TEMPLATE}`,
        at: gap.at,
      };

/**
 * The template, or `undefined` when this tree has none. A fixture root — `scripts/verify.test.ts`
 * builds several — has no `packages/cli`, and a raw ENOENT out of `Bun.file().text()` would take
 * the whole `manifest` step down with a stack instead of a finding. Same rule
 * `scripts/scaffold-smoke-overrides.ts` states for its own missing directory: "found nothing" is an
 * instruction, a thrown ENOENT is not.
 */
const templateSource = async (root: string): Promise<string | undefined> => {
  const file = Bun.file(`${root}/${SETUP_TEMPLATE}`);
  return (await file.exists()) ? await file.text() : undefined;
};

const missingTemplate: SetupGap = {
  kind: 'unscanned',
  at: SETUP_TEMPLATE,
  detail: `${SETUP_TEMPLATE} is not in this tree, so the sequence bin/setup runs could not be read and no page could be compared against it`,
};

/** One read of the template, both answers off it — the gaps and the steps a finding names. */
export const setupCommandReport = async (
  root: string,
): Promise<{ readonly steps: readonly SetupStep[]; readonly gaps: readonly SetupGap[] }> => {
  const template = await templateSource(root);
  if (template === undefined) return { steps: [], gaps: [missingTemplate] };
  const steps = setupSteps(template);
  return { steps, gaps: checkSetupCommands({ pages: await readDocPages(root), steps }) };
};

export const setupCommandGaps = async (root: string): Promise<readonly SetupGap[]> =>
  (await setupCommandReport(root)).gaps;

/** What this rule contributes to `x verify`'s `manifest` step. */
export const setupCommandFindings = async (root: string): Promise<readonly Finding[]> => {
  const { steps, gaps } = await setupCommandReport(root);
  return gaps.map((gap) => setupCommandFindingFor(gap, steps));
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { steps, gaps } = await setupCommandReport(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `every documented bin/setup list matches the ${String(steps.length)} steps the scaffold writes: ${steps.map((step) => step.id).join(', ')}`
          : `${String(gaps.length)} page(s) describe a bin/setup this scaffold does not write`,
      findings: gaps.map((gap) => setupCommandFindingFor(gap, steps)),
      data: { steps: steps.map((step) => step.id) },
    },
    args.json,
  );
}
