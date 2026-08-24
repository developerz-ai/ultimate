#!/usr/bin/env bun
// Enforce, as a gate step, that a page stating how many steps `x verify` runs — or enumerating
// them — states the list this build actually ships.
//
// The gap this closes: `VERIFY_STEP_NAMES` grew an 18th step (`seo`, #220) and 20 markdown files
// went on saying "17 steps" through a whole major release, root `CLAUDE.md` among them. A count
// hand-copied into 20 files goes stale in 19 of them, and nothing compared any of them to the
// list. `scripts/release-facts.ts` is the same shape of rule over the same file set, for the same
// reason.
//
// TWO RULES, because a page can be stale in two ways and the fixes differ. The COUNT is wrong when
// the total moved. The LIST is wrong when a step was inserted — and a list can be wrong while its
// own count is right, which is the failure a count check alone would wave through.
//
// The PASSED half of `14 of 20 steps passed` is deliberately not derived: what passes depends on
// the repo, the app and what is skipped. Only the total is a fact about the build, and a passed
// count above the total is the one thing that is wrong on its face.
//
//   bun run scripts/gate-steps.ts [--json]

import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'gate-steps';

/**
 * Not only `.md`. `llms.txt` is the machine-readable repo map and stated `eighteen steps` while
 * omitting `i18n`; a workflow, a script header and an agent brief make the same claim in the same
 * words. `readMarkdown` reads any glob, so the file set was the only thing keeping four whole
 * surfaces outside a rule that already knew how to judge them.
 */
export const STEP_GLOBS: readonly string[] = [
  '*.md',
  'llms.txt',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'examples/*/*.md',
  'dummy/*/*.md',
  // Both extensions: GitHub Actions accepts `.yaml` as readily as `.yml`, so a glob reading one of
  // them is a rule a single renamed workflow walks out of.
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.claude/**/*.md',
  'scripts/**/*.ts',
];

/**
 * `docs/plans/` is a dated record of work and `CHANGELOG.md` names every past release's step count
 * by design — 1.0.0 really did ship 17. Both are history: a rule that read them would demand the
 * past be rewritten, which is what `scripts/release-facts.ts` and `scripts/doc-commands.ts` both
 * say about the same two paths.
 *
 * A `.test.ts` is skipped for the reason `scripts/render-modes.ts` skips one: a fixture stating a
 * wrong count is INPUT to the rule under test, never a claim a reader could be misled by.
 */
export const skipStepPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md' || /\.test\.tsx?$/.test(path);

/** A line pinning an OLDER release states that release's count — "1.0.0 shipped 17 steps". */
const HISTORICAL =
  /\b\d+\.\d+\.\d+\s+(?:shipped|published|carried|had|ran)\b|\bused to\b|\bwas\s+\d+\s+steps\b/;

/**
 * The line has to be ABOUT the gate before a bare "N steps" on it is a claim about the gate.
 * Without this, `packages/jobs/CLAUDE.md`'s "20,000 steps" — a backfill's page count — reads as a
 * gate claim, and a rule that reports a true sentence is a rule its readers learn to ignore.
 * `N of M steps` needs no context: that phrasing IS `x verify`'s summary line.
 */
const GATE_CONTEXT =
  /x verify|bun run verify|VERIFY_STEP|the gate\b|bin\/check|"command":\s*"verify"/i;

/**
 * A SUBSET of the steps, never the total: "pinned red on 4 steps", "3 steps skipped". Consumed as a
 * SPAN rather than tested against the whole line — "Green = shippable" sits on the same line as
 * `CLAUDE.md`'s real total, so a line-level veto silences the claim this rule exists to read.
 */
const SUBSET_SPANS =
  /\bpinned(?:\s+red)?\s+on\s+\d+\s+steps?\b|\b\d+\s+steps?\s+(?:pinned|skipped)\b/gi;

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** `N of M steps` — the gate's own summary format. `M` is the total; `N` may never exceed it. */
const OF_TOTAL = /\b(\d+)\s+of\s+(\d+)\s+steps\b/g;

/**
 * The same tally with the word `steps` somewhere else in the sentence: a table cell writing the
 * numerals alone, an app's CLAUDE.md writing `N red of M`. Both shipped green, because the rule
 * above demands the literal word BESIDE the numerals.
 *
 * TWO shapes, not one loose pattern. `N red of M` is unambiguous wherever it appears. A bare tally
 * is only read when nothing follows it — a lowercase word after the second numeral makes it a count
 * of that noun (`24 of 30 packages`, `29 of 30 package tsconfigs`), which is three sentences in
 * this tree and none of them about the gate.
 */
const OF_TOTAL_LOOSE = /\b(\d+)\s+red\s+of\s+(\d+)\b|\b(\d+)\s+of\s+(\d+)\b(?!\s*[a-z])/g;

/** A line that says `step` is talking about steps — the context the loose tally needs. */
const STEP_WORD = /\bsteps?\b/i;

/**
 * A count SPELLED OUT with no `steps` after it — `packages/cli/README.md` wrote "Seventeen, in cost
 * order" above a list of 17 names and was green, because every count rule here wants a numeral or
 * the literal word beside it.
 *
 * Capitalised and sentence-initial, which is the only form that states a total on its own: a
 * lowercase one is a measurement of something else, and `wiki/Tutorial-02-First-Feature.md`'s
 * "a twenty-line script" is exactly the sentence a looser rule reports and a reader learns to
 * silence. The lowercase form beside the word `steps` is already the rule above.
 */
const WORD_TOTAL = /(?:^|[.!?)]\s+)(Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\b/g;

/**
 * A paragraph that is step names and separators and NOTHING else is a list claiming to be the whole
 * gate, whatever it says about itself. `packages/cli/README.md` presents the list exactly this way
 * and shipped 17 of the names; the enumeration rule below could not see it, because that rule reads
 * one LINE and the list wraps. Five is the floor: four names is a citation, not a list.
 */
export const RUN_THRESHOLD = 5;

const RUN_SEPARATORS = /[\s,;·`|*_()[\]]+/g;

/** A bare total, once the `N of M` spans have been consumed. Word form included: `wiki/FAQ.md`
 * spells it "Seventeen steps", which a digit-only rule reads as no claim at all. */
const BARE_TOTAL =
  /\b(?:all|its|the|same|only|and)?\s*(\d+|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)[-\s](?:named\s+|ordered\s+|gate\s+)?steps?\b/gi;

const numberOf = (token: string): number =>
  WORD_NUMBERS[token.toLowerCase()] ?? Number.parseInt(token, 10);

export type StepGapKind = 'count' | 'passed' | 'list' | 'vacuous';

export interface StepGap {
  readonly kind: StepGapKind;
  readonly at: string;
  readonly quote: string;
  readonly detail: string;
}

export interface StepInput {
  readonly pages: readonly MarkdownFile[];
  readonly steps: readonly string[];
}

/**
 * One alternation, longest name first, on word boundaries. Both halves earn their line: without
 * `\\b`, "a check that lives only in CI" contributes `live` at column 30 and the whole list reads as
 * mis-ordered; without longest-first, `contract-diff` is consumed as `contract` followed by
 * punctuation. `wiki/FAQ.md` contains both traps in one sentence.
 */
function stepPattern(steps: readonly string[]): RegExp {
  const alternation = [...steps]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[-]/g, '\\-'))
    .join('|');
  return new RegExp(`\\b(?:${alternation})\\b`, 'g');
}

/** Every known step name on this line, in the order it writes them, first occurrence only. */
function namedInOrder(line: string, steps: readonly string[]): readonly string[] {
  const seen: string[] = [];
  for (const match of line.matchAll(stepPattern(steps))) {
    const name = match[0] ?? '';
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Whether this line enumerates the WHOLE gate rather than a subset. Anchored on the first and last
 * step names together: the six test types (`unit, contract, live, job, e2e, eval`) name six steps
 * and neither anchor, so a rule counting names alone would report the one line that is correct by
 * construction.
 */
function enumeratesGate(line: string, steps: readonly string[]): boolean {
  const named = namedInOrder(line, steps);
  return named.includes(steps[0] ?? '') && named.includes(steps[steps.length - 1] ?? '');
}

/** One paragraph of a page — blank-line separated, code fences dropped — with where it starts. */
interface Paragraph {
  readonly line: number;
  readonly text: string;
}

function paragraphsOf(page: MarkdownFile): readonly Paragraph[] {
  const found: Paragraph[] = [];
  const lines = page.text.split('\n');
  let fenced = false;
  let buffer: string[] = [];
  let start = 1;
  const flush = (): void => {
    if (buffer.length > 0) found.push({ line: start, text: buffer.join(' ') });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim() === '') {
      flush();
      continue;
    }
    if (buffer.length === 0) start = index + 1;
    buffer.push(line.trim());
  }
  flush();
  return found;
}

/**
 * Whether this paragraph is step names and separators and nothing else. Read after the names are
 * removed rather than by counting them: a paragraph with prose in it is a SENTENCE about some
 * steps, and only a bare run is a page presenting the list itself.
 */
function bareRun(text: string, steps: readonly string[]): readonly string[] | undefined {
  const named = namedInOrder(text, steps);
  if (named.length < RUN_THRESHOLD) return undefined;
  const left = text.replace(stepPattern(steps), '').replace(RUN_SEPARATORS, '');
  return left === '' ? named : undefined;
}

export function checkGateSteps(input: StepInput): readonly StepGap[] {
  const gaps: StepGap[] = [];
  const total = input.steps.length;
  const ordered = input.steps.join(', ');
  let claims = 0;

  for (const page of input.pages) {
    // Where the line rule already reported a list. A one-line bare run of five or more names
    // satisfies BOTH detectors — `enumeratesGate` sees the first and last step, `bareRun` sees a
    // line that is nothing but names — and a one-line paragraph starts on the line it is, so the
    // two produce byte-identical findings. One condition, one finding (axiom 1).
    const listed = new Set<string>();
    const lines = page.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (HISTORICAL.test(line)) continue;
      const at = `${page.path}:${index + 1}`;

      // Spans are consumed as they match, so `14 of 20 steps` is read once as a total and not a
      // second time by the bare-total rule — one sentence, one finding.
      let rest = line;
      for (const match of line.matchAll(OF_TOTAL)) {
        claims += 1;
        const passed = numberOf(match[1] ?? '0');
        const claimed = numberOf(match[2] ?? '0');
        rest = rest.replace(match[0] ?? '', ' ');
        if (claimed !== total) {
          gaps.push({
            kind: 'count',
            at,
            quote: (match[0] ?? '').trim(),
            detail: `states ${claimed} steps; \`x verify\` runs ${total}`,
          });
        } else if (passed > claimed) {
          gaps.push({
            kind: 'passed',
            at,
            quote: (match[0] ?? '').trim(),
            detail: `${passed} steps cannot pass out of ${claimed}`,
          });
        }
      }

      for (const match of rest.matchAll(SUBSET_SPANS)) rest = rest.replace(match[0] ?? '', ' ');

      if (GATE_CONTEXT.test(line) || STEP_WORD.test(line)) {
        for (const match of rest.matchAll(OF_TOTAL_LOOSE)) {
          claims += 1;
          const claimed = numberOf(match[2] ?? match[4] ?? '0');
          rest = rest.replace(match[0] ?? '', ' ');
          if (claimed === total) continue;
          gaps.push({
            kind: 'count',
            at,
            quote: (match[0] ?? '').trim(),
            detail: `states ${claimed} steps; \`x verify\` runs ${total}`,
          });
        }
      }

      if (GATE_CONTEXT.test(line)) {
        // BARE_TOTAL is matched first and its spans consumed, so `Nineteen steps` is one claim
        // rather than two — the word rule below reads only what is left.
        const bare = [...rest.matchAll(BARE_TOTAL)];
        for (const match of bare) rest = rest.replace(match[0] ?? '', ' ');
        for (const match of [...bare, ...rest.matchAll(WORD_TOTAL)]) {
          claims += 1;
          const claimed = numberOf(match[1] ?? '0');
          if (claimed === total) continue;
          gaps.push({
            kind: 'count',
            at,
            quote: (match[0] ?? '').trim(),
            detail: `states ${claimed} steps; \`x verify\` runs ${total}`,
          });
        }
      }

      if (!enumeratesGate(line, input.steps)) continue;
      claims += 1;
      listed.add(at);
      const named = namedInOrder(line, input.steps);
      if (named.join(', ') === ordered) continue;
      const missing = input.steps.filter((name) => !named.includes(name));
      gaps.push({
        kind: 'list',
        at,
        quote: named.join(', '),
        detail:
          missing.length > 0
            ? `omits ${missing.join(', ')}`
            : 'names every step, but not in the order the gate runs them',
      });
    }

    for (const paragraph of paragraphsOf(page)) {
      const named = bareRun(paragraph.text, input.steps);
      if (named === undefined || listed.has(`${page.path}:${paragraph.line}`)) continue;
      claims += 1;
      if (named.join(', ') === ordered) continue;
      const missing = input.steps.filter((name) => !named.includes(name));
      gaps.push({
        kind: 'list',
        at: `${page.path}:${paragraph.line}`,
        quote: named.join(', '),
        detail:
          missing.length > 0
            ? `omits ${missing.join(', ')}`
            : 'names every step, but not in the order the gate runs them',
      });
    }
  }

  if (claims === 0) {
    gaps.push({
      kind: 'vacuous',
      at: STEP_GLOBS[0] ?? '',
      quote: '',
      detail: 'no page states a step count or enumerates the gate, so this rule read nothing',
    });
  }
  return gaps;
}

const listFix = (steps: readonly string[]): string =>
  `write the list as: ${steps.join(', ')} — \`bun run scripts/gate-steps.ts --json\` re-reads it from VERIFY_STEP_NAMES`;

export function gateStepFinding(gap: StepGap, steps: readonly string[]): Finding {
  if (gap.kind === 'vacuous') {
    return {
      code: 'X_DOC_GATE_STEPS_UNSCANNED',
      cause: gap.detail,
      // A literal path, not an interpolation: the fix-line rule reads these statically.
      fix: 'edit STEP_GLOBS in scripts/gate-steps.ts so it matches the pages that state a step count',
      at: 'scripts/gate-steps.ts',
    };
  }
  if (gap.kind === 'list') {
    return {
      code: 'X_DOC_GATE_STEPS_STALE',
      cause: `${gap.at} enumerates the gate and ${gap.detail}`,
      fix: listFix(steps),
      at: gap.at,
    };
  }
  return {
    code: 'X_DOC_GATE_STEPS_STALE',
    cause: `${gap.at} writes "${gap.quote}" and ${gap.detail}`,
    fix: `set the count at ${gap.at} to ${steps.length}; run \`bun run scripts/gate-steps.ts --json\` to re-derive it`,
    at: gap.at,
  };
}

export const readStepPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of STEP_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipStepPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

export const gateStepGaps = async (root: string): Promise<readonly StepGap[]> =>
  checkGateSteps({ pages: await readStepPages(root), steps: [...VERIFY_STEP_NAMES] });

/** What this repo contributes to `x verify`'s `manifest` step. */
export const gateStepFindings = async (root: string): Promise<readonly Finding[]> =>
  (await gateStepGaps(root)).map((gap) => gateStepFinding(gap, [...VERIFY_STEP_NAMES]));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await gateStepGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `every stated step count and step list matches the ${VERIFY_STEP_NAMES.length} steps this build runs`
          : `${gaps.length} page(s) describe a gate this build does not run`,
      findings: gaps.map((gap) => gateStepFinding(gap, [...VERIFY_STEP_NAMES])),
    },
    args.json,
  );
}
