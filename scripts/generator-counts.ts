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

// why: a scratch scaffold for `x g` to run in; Bun has no temporary-directory or path API.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, planNewApp, writeNewApp } from '@ultimat3/cli';
import { readDocPages } from './doc-commands';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

/** One spelling of one generator, and the file count it really emits. */
export interface GeneratorVariant {
  /** The flags that select it, as a reader writes them. Empty is the default spelling. */
  readonly flags: readonly string[];
  readonly files: number;
  /** Where the count holds, as a finding names it: `the default scaffold, after setup`. */
  readonly shape?: string;
}

export interface GeneratorFacts {
  /** How a finding names it: `x new`, `x g resource`. */
  readonly id: string;
  readonly variants: readonly GeneratorVariant[];
}

/**
 * The two files `bun run setup` leaves that `x g` reads: their presence is what makes a real run
 * re-project them, and count them. The rest of setup (install, migrate, seed) changes no count.
 */
export const SETUP_ARTIFACTS: readonly string[] = ['x.manifest.json', 'openapi.json'];

const DryRun = (value: unknown): { files: number; refreshes: number } | undefined => {
  if (typeof value !== 'object' || value === null || !('data' in value)) return undefined;
  const data: unknown = value.data;
  if (typeof data !== 'object' || data === null || !('files' in data)) return undefined;
  const files: unknown = data.files;
  const refreshes: unknown = 'refreshes' in data ? data.refreshes : [];
  if (!Array.isArray(files) || !Array.isArray(refreshes)) return undefined;
  return { files: files.length, refreshes: refreshes.length };
};

/**
 * What `x g resource` PRINTS, measured by running it: `x g resource widget [--admin] --dry-run
 * --json` in each scaffold shape, holding setup's two artifacts. Tutorial 1 makes the default
 * app and Tutorial 2 generates into it; a `--no-example` app prints more, because the example
 * slice already made two `package.json` edits a bare app still owes. Two numbers per spelling and
 * shape: `data.files` is what a dry run and a real run before setup print, and a real run after
 * setup adds `data.refreshes`, the projections it rewrites.
 *
 * `generate()`'s array was measured here until 2026-11-03, and it is not what the command prints:
 * the command also edits the role map, the API index, the db handle and two `package.json` files,
 * so every page quoting the planner's 33 named a number no run of `x g` has ever shown.
 */
const SHAPES = [
  { example: true, shape: 'the default scaffold' },
  { example: false, shape: 'a --no-example scaffold' },
] as const;

async function resourceVariants(): Promise<readonly GeneratorVariant[]> {
  const variants: GeneratorVariant[] = [];
  for (const one of SHAPES) variants.push(...(await shapeVariants(one.example, one.shape)));
  return variants;
}

async function shapeVariants(
  example: boolean,
  shape: string,
): Promise<readonly GeneratorVariant[]> {
  const dir = await mkdtemp(join(tmpdir(), 'generator-counts-'));
  try {
    await writeNewApp(dir, { name: 'probe', example });
    for (const file of SETUP_ARTIFACTS) await Bun.write(join(dir, file), '{}\n');
    const variants: GeneratorVariant[] = [];
    for (const flags of [[], ['--admin']]) {
      const out: string[] = [];
      const argv = ['g', 'resource', 'widget', ...flags, '--dry-run', '--json'];
      const code = await dispatch({
        argv,
        cwd: dir,
        env: {},
        bunVersion: Bun.version,
        write: (line) => out.push(line),
      });
      const run = code === 0 ? DryRun(JSON.parse(out.join('\n'))) : undefined;
      if (run === undefined) {
        throw new ScriptError({
          code: 'X_DOC_FILE_COUNT_UNSCANNED',
          cause: `x ${argv.join(' ')} in ${shape} exited ${String(code)} without a file list`,
          fix: `bun run scripts/generator-counts.ts --json   # then run x ${argv.join(' ')} in a fresh \`x new probe\` app (and one with --no-example) and fix what it reports`,
        });
      }
      variants.push(
        { flags, files: run.files, shape: `${shape}, before setup` },
        { flags, files: run.files + run.refreshes, shape: `${shape}, after setup` },
      );
    }
    return variants;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What `x g sign-in` PRINTS, both shapes, in the default scaffold before and after setup — measured
 * by its own dry run, exactly as `x g resource` is. One run per shape, each in a fresh scaffold:
 * an app has one sign-in, so a second run into the same app is a conflict and counts nothing.
 */
async function signInVariants(): Promise<readonly GeneratorVariant[]> {
  const variants: GeneratorVariant[] = [];
  for (const flags of [['--password'], ['--oidc', 'corp-sso']]) {
    const dir = await mkdtemp(join(tmpdir(), 'generator-counts-'));
    try {
      await writeNewApp(dir, { name: 'probe', example: true });
      for (const file of SETUP_ARTIFACTS) await Bun.write(join(dir, file), '{}\n');
      const out: string[] = [];
      const argv = ['g', 'sign-in', ...flags, '--dry-run', '--json'];
      const code = await dispatch({
        argv,
        cwd: dir,
        env: {},
        bunVersion: Bun.version,
        write: (line) => out.push(line),
      });
      const run = code === 0 ? DryRun(JSON.parse(out.join('\n'))) : undefined;
      if (run === undefined) {
        throw new ScriptError({
          code: 'X_DOC_FILE_COUNT_UNSCANNED',
          cause: `x ${argv.join(' ')} in the default scaffold exited ${String(code)} without a file list`,
          fix: `bun run scripts/generator-counts.ts --json   # then run x ${argv.join(' ')} in a fresh \`x new probe\` app and fix what it reports`,
        });
      }
      // The flag that names the shape is what a doc line writes: `--oidc`, never its value.
      const shape = flags.slice(0, 1);
      variants.push(
        { flags: shape, files: run.files, shape: 'the default scaffold, before setup' },
        {
          flags: shape,
          files: run.files + run.refreshes,
          shape: 'the default scaffold, after setup',
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return variants;
}

/**
 * `x g action` is deliberately absent, and the reason is a property of the generator rather than an
 * omission. `writeFiles` SKIPS a slice module that already exists (`cmd-generate.ts`), so an
 * action's count depends on how much of the slice is already there — `wiki/CLI-Reference.md:233`
 * says "exactly its own 3 files" into a finished slice and `wiki/Tutorial-02` says 8 into a bare
 * one, both correct English about different states.
 *
 * `x new` has no such dimension, and its planner IS its count: `cmd-new.ts` writes every planned
 * file and prints that list. `x g resource` creates its own slice, so one scaffold per shape measures it.
 */
export async function generatorFacts(): Promise<readonly GeneratorFacts[]> {
  return [
    {
      id: 'x new',
      variants: [
        { flags: [], files: planNewApp({ name: 'probe', example: true }).length },
        { flags: ['--no-example'], files: planNewApp({ name: 'probe', example: false }).length },
      ],
    },
    { id: 'x g resource', variants: await resourceVariants() },
    { id: 'x g sign-in', variants: await signInVariants() },
  ];
}

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
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const spoken of readTranscriptClaims(line)) {
        const facts = byId.get(spoken.id);
        if (facts === undefined) continue;
        claims += 1;
        const every = facts.variants.map((variant) => variant.files);
        if (every.includes(spoken.value)) continue;
        gaps.push({
          kind: 'stale',
          at: `${page.path}:${index + 1}`,
          generator: facts.id,
          claimed: spoken.value,
          expected: every,
          detail: emits(facts.variants),
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
