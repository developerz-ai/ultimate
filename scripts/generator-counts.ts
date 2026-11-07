#!/usr/bin/env bun
// Enforce, as a gate step, that every file count a doc states about a generator is a number that
// generator still prints. The counts are DERIVED here — `x new`'s from its planner, `x g`'s from the
// command itself run on a scaffold — never restated, so a template that adds a file makes the
// prose red on the same commit.
//
// The gap this closes: `x new` 125, `--no-example` 99, `x g resource` 27, `--live --admin` 29 and
// `x g action` 9 were a convention held by nobody. Five had gone stale and were corrected in #209
// by running the generators BY HAND, which is the step that does not happen again. Measured while
// writing this: `wiki/Tutorial-02-First-Feature.md` still claimed 25 and 27 for `x g resource`,
// two more than #209 caught, because that page states them in prose rather than in a table row.
//
//   bun run scripts/generator-counts.ts [--json]

import { readDocPages } from './doc-commands';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import {
  type GeneratorFacts,
  type GeneratorVariant,
  generatorFacts,
} from './lib/generator-variants';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

/**
 * Every generator an `x g <kind>` / `x new` span on a line names, modelled or not. Unmodelled ones
 * are tracked ON PURPOSE: `wiki/Tutorial-02` writes "`x g job` is 5 files … `x g action` 8" on one
 * line, and a scanner that saw only the generators it models would hand `x g job`'s 5 to
 * `x g action` and report a finding on a sentence that is right.
 */
const MENTION = /\bx new\b|\bx g ([a-z:]+)/g;

export interface Mention {
  readonly at: number;
  readonly id: string;
}

export function readMentions(line: string): readonly Mention[] {
  return [...line.matchAll(MENTION)].map((match) => ({
    at: match.index ?? 0,
    id: match[1] === undefined ? 'x new' : `x g ${match[1]}`,
  }));
}

/** A number a doc line states as a file count, with what the same line associates with it. */
export interface CountClaim {
  readonly at: number;
  readonly value: number;
  /** The `--flag` tokens between this claim and the next one on the line. */
  readonly flags: readonly string[];
  /** `with` associates flags; `without`, a bare `N files` and an elided count do not. */
  readonly associated: boolean;
  /** Whether the run-up to this claim named a different subject. See `checkGeneratorCounts`. */
  readonly qualified: boolean;
}

/**
 * A number counts as a claim only when the prose says so: `N files`, `N file(s)`, `N with`/
 * `N without` a variant, or the elision a table cell uses — an invocation followed by a bare
 * number (`` `x g action` 8 ``). Everything else is left alone: `up from 114/90` on
 * `wiki/CLI-Reference.md` is a HISTORY, and a rule that read every integer would fail on it.
 */
const CLAIM = /(\d+)\*{0,2}\s*(files?\b|file\(s\)|with\b|without\b)/g;
const ELIDED = /(?:\bx new\b|\bx g [a-z:]+)`?\s+(\d+)\b/g;

/**
 * The generator's OWN success line, quoted in a transcript: `cli.generate.wrote` in
 * `packages/cli/src/messages.ts` is `wrote {count} file(s) for {kind} {name}`, and `--dry-run`'s
 * is `would write {count} …`. A tutorial that pastes one is stating a count with no prose around
 * it to misread, which is why it is matched exactly rather than left to the heuristics above —
 * `wiki/Tutorial-02-First-Feature.md` shows `✓ wrote 25 file(s) for resource todo` and the
 * generator writes 27.
 */
const TRANSCRIPT = /(?:wrote|would write)\s+(\d+)\s+file\(s\)\s+for\s+([a-z:]+)\b/g;

export interface TranscriptClaim {
  readonly value: number;
  readonly id: string;
}

export const readTranscriptClaims = (line: string): readonly TranscriptClaim[] =>
  [...line.matchAll(TRANSCRIPT)].map((match) => ({
    value: Number.parseInt(match[1] ?? '0', 10),
    id: `x g ${match[2] ?? ''}`,
  }));

/**
 * A count qualified by a NAMED ARTIFACT is a count about that artifact, not about the generator.
 * Five pages write "`x new` writes … `docker/helm`, 8 files" and one writes "helm/ — the chart, 8
 * files"; every one is correct English and none is a claim about `x new`'s output.
 *
 * This is a heuristic and the only one in the file — a path-shaped token or the word `chart`
 * between the previous claim and this one. It is stated rather than hidden because the honest
 * alternative is parsing English, and the cost of getting it wrong is a false finding on prose
 * that is right, which is how a gate stops being read.
 */
const QUALIFIER = /[\w.-]+\/[\w./-]*|\bcharts?\b/;

export function readCountClaims(line: string): readonly CountClaim[] {
  const found = [
    ...[...line.matchAll(CLAIM)].map((match) => ({
      at: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      value: Number.parseInt(match[1] ?? '0', 10),
      associated: match[2] === 'with',
    })),
    // Positioned at the NUMBER, not at the invocation that precedes it: `at` is what decides which
    // invocation owns the claim, and anchoring it on the mention made every elided count belong to
    // whichever generator came before its own.
    ...[...line.matchAll(ELIDED)].map((match) => ({
      at: (match.index ?? 0) + match[0].length - (match[1] ?? '').length,
      end: (match.index ?? 0) + match[0].length,
      value: Number.parseInt(match[1] ?? '0', 10),
      associated: false,
    })),
  ]
    .sort((a, b) => a.at - b.at)
    // `x g action` 8 files matches BOTH forms at the same offset; one claim, reported once.
    .filter((claim, index, all) => index === 0 || claim.at !== all[index - 1]?.at);
  return found.map((claim, index) => ({
    at: claim.at,
    value: claim.value,
    associated: claim.associated,
    flags: [
      ...line.slice(claim.end, found[index + 1]?.at ?? line.length).matchAll(/--[a-z][a-z-]*/g),
    ].map((flag) => flag[0]),
    qualified: QUALIFIER.test(line.slice(index === 0 ? 0 : (found[index - 1]?.end ?? 0), claim.at)),
  }));
}

export interface CountGapInput {
  readonly pages: readonly MarkdownFile[];
  readonly facts: readonly GeneratorFacts[];
}

export interface CountGap {
  readonly kind: 'stale' | 'vacuous';
  readonly at: string;
  readonly generator: string;
  readonly claimed: number;
  readonly expected: readonly number[];
  readonly detail: string;
}

/**
 * What a finding says the generator prints: each count with the shape it holds in, so a page that
 * states one shape's number is told which number that shape prints, never a bare list of every one.
 */
export const emits = (variants: readonly GeneratorVariant[]): string => {
  if (variants.every((variant) => variant.shape === undefined)) {
    return `emits ${[...new Set(variants.map((variant) => variant.files))].join(' or ')} files`;
  }
  const parts = variants.map((one) => `${String(one.files)} in ${one.shape ?? 'any shape'}`);
  return `emits ${parts.join(', or ').replace(/^(\d+) in/, '$1 files in')}`;
};

/** Every variant a `N with --flag` claim names: a spelling can print two counts, before and after setup. */
const variantsFor = (facts: GeneratorFacts, claim: CountClaim): readonly GeneratorVariant[] =>
  claim.associated && claim.flags.length > 0
    ? facts.variants.filter((variant) => variant.flags.some((flag) => claim.flags.includes(flag)))
    : [];

/**
 * A pasted `wrote N file(s)` line is the output of the command fence above it, so it is held to
 * THAT spelling's counts, not to every variant's. Membership alone let `wiki/Tutorial-03` show the
 * bare spelling's 41 under `x g resource note --admin` while `tutorial-run` was red on `main`.
 * Only shell fences count: prose naming the command is not the run being transcribed.
 */
const SHELL_FENCES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'console']);

export const readCommands = (
  line: string,
): readonly { readonly id: string; readonly flags: readonly string[] }[] =>
  readMentions(line).map((mention) => ({
    id: mention.id,
    flags: [...line.slice(mention.at).matchAll(/--[a-z][a-z-]*/g)].map((flag) => flag[0]),
  }));

/** The variants whose modelled flags are exactly the modelled flags the command was run with. */
const variantsRun = (
  facts: GeneratorFacts,
  ran: readonly string[],
): readonly GeneratorVariant[] => {
  const modelled = new Set(facts.variants.flatMap((variant) => variant.flags));
  const used = ran.filter((flag) => modelled.has(flag));
  return facts.variants.filter(
    (variant) =>
      variant.flags.length === used.length && variant.flags.every((flag) => used.includes(flag)),
  );
};

/**
 * Which generator a claim is about: the invocation NEAREST BEFORE it on the line, and when none
 * precedes it, the line's sole invocation. `wiki/CLI-Reference.md` states `x new`'s counts in a
 * paragraph whose only mention of the command comes after them, and a rule that required the
 * mention first would read that page's numbers as belonging to nothing.
 *
 * `undefined` when the line names two invocations and the claim precedes both — ambiguous, and a
 * guess there is a finding on prose nobody can act on.
 */
export function ownerOf(mentions: readonly Mention[], claim: CountClaim): string | undefined {
  const before = mentions.filter((mention) => mention.at < claim.at);
  if (before.length > 0) return before[before.length - 1]?.id;
  const ids = new Set(mentions.map((mention) => mention.id));
  return ids.size === 1 ? mentions[0]?.id : undefined;
}

/**
 * Two rules, and the weaker one is deliberate.
 *
 * MEMBERSHIP: every count a line states about a generator must be a number that generator emits in
 * SOME documented variant. Direction-free on purpose — the corpus states the same fact five ways
 * (`29 files — 27 without either flag` inverts `27 files (29 with --admin)`), and a rule that
 * insisted on reading which is which would report findings on prose that is correct.
 *
 * ASSOCIATION: when a line writes `N with --flag`, N must be THAT variant's count. This is what
 * catches a stale number that is still valid for the other spelling, which membership cannot see.
 * Applied only to `with`, never to `without`, for the same reason.
 *
 * Neither catches a line that swaps two currently-valid numbers between variants without writing
 * `with`. That is stated rather than papered over: the alternative is parsing English.
 */
export function checkGeneratorCounts(input: CountGapInput): readonly CountGap[] {
  const gaps: CountGap[] = [];
  const byId = new Map(input.facts.map((facts) => [facts.id, facts]));
  let claims = 0;
  for (const page of input.pages) {
    const lines = page.text.split('\n');
    const commands = new Map<string, readonly string[]>();
    let shell = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const fence = /^\s*```(\w*)/.exec(line);
      if (fence !== null) shell = !shell && SHELL_FENCES.has(fence[1] ?? '');
      else if (shell)
        for (const command of readCommands(line)) commands.set(command.id, command.flags);
      for (const spoken of readTranscriptClaims(line)) {
        const facts = byId.get(spoken.id);
        if (facts === undefined) continue;
        claims += 1;
        const ran = commands.get(spoken.id);
        const named = ran === undefined ? facts.variants : variantsRun(facts, ran);
        const every = named.map((variant) => variant.files);
        if (every.includes(spoken.value)) continue;
        gaps.push({
          kind: 'stale',
          at: `${page.path}:${index + 1}`,
          generator: facts.id,
          claimed: spoken.value,
          expected: every,
          detail: emits(named),
        });
      }
      const mentions = readMentions(line);
      if (mentions.length === 0) continue;
      for (const claim of readCountClaims(line)) {
        if (claim.qualified) continue;
        const facts = byId.get(ownerOf(mentions, claim) ?? '');
        if (facts === undefined) continue;
        claims += 1;
        const every = facts.variants.map((variant) => variant.files);
        const named = variantsFor(facts, claim);
        const expected = named.length === 0 ? every : named.map((variant) => variant.files);
        if (expected.includes(claim.value)) continue;
        gaps.push({
          kind: 'stale',
          at: `${page.path}:${index + 1}`,
          generator: facts.id,
          claimed: claim.value,
          expected,
          detail:
            named.length === 0
              ? emits(facts.variants)
              : `${emits(named)} with ${named[0]?.flags.join(' ') ?? ''}`,
        });
      }
    }
  }
  if (claims === 0) {
    gaps.push({
      kind: 'vacuous',
      at: 'wiki/',
      generator: '',
      claimed: 0,
      expected: [],
      detail: 'no page states a generator file count, so this rule read nothing and reported green',
    });
  }
  return gaps;
}

const staleFinding = (gap: CountGap): Finding => ({
  code: 'X_DOC_FILE_COUNT_STALE',
  cause: `${gap.at} says ${gap.generator} produces ${String(gap.claimed)} files, and it ${gap.detail}`,
  fix: `set the count at ${gap.at} to ${gap.expected.join(' or ')}, or re-derive it with \`x g --dry-run --json\` / \`x new --dry-run --json\` and count data.files (a real run after setup adds data.refreshes)`,
  at: gap.at,
});

const vacuousFinding = (gap: CountGap): Finding => ({
  code: 'X_DOC_FILE_COUNT_UNSCANNED',
  cause: gap.detail,
  fix: 'check DOC_GLOBS in scripts/doc-commands.ts still matches the pages, and CLAIM in scripts/generator-counts.ts still matches how they state a count',
  at: 'scripts/generator-counts.ts',
});

export const generatorCountFindingFor = (gap: CountGap): Finding =>
  gap.kind === 'vacuous' ? vacuousFinding(gap) : staleFinding(gap);

export const generatorCountGaps = async (
  root: string,
  facts?: readonly GeneratorFacts[],
): Promise<readonly CountGap[]> =>
  checkGeneratorCounts({
    pages: await readDocPages(root),
    facts: facts ?? (await generatorFacts()),
  });

/** What this repo contributes to `x verify`'s `manifest` step. */
export const generatorCountFindings = async (root: string): Promise<readonly Finding[]> => {
  try {
    return (await generatorCountGaps(root)).map(generatorCountFindingFor);
  } catch (error) {
    // A scaffold `x g` could not run in is a rule that read nothing: its own finding, never a throw
    // out of the gate step every other rule shares.
    if (error instanceof ScriptError) return [error.toFinding()];
    throw error;
  }
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const facts = await generatorFacts();
  const gaps = await generatorCountGaps(repoRoot(), facts);
  report(
    {
      ok: gaps.length === 0,
      script: 'generator-counts',
      summary:
        gaps.length === 0
          ? `every documented file count matches the generators (${facts.map((f) => `${f.id} ${f.variants.map((v) => String(v.files)).join('/')}`).join(', ')})`
          : `${gaps.length} documented generator file count(s) no longer match`,
      findings: gaps.map(generatorCountFindingFor),
    },
    args.json,
  );
}
