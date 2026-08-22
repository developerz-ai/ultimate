#!/usr/bin/env bun
// One rule: a closed set of string literals is declared in ONE module and nowhere else — compared
// by LITERAL SET, never by name, because the copy that did the damage was called `PwaRenderMode`
// and a rule keyed on the word `RenderMode` reads straight past it. Six vocabularies, each with its
// own owning module, and two known divergences held out until a decision lands (see below).
//   bun run scripts/render-modes.ts [--json]

import { maskLiterals, stripComments } from '@ultimat3/cli';
import { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
import { JOB_STATES } from '@ultimat3/jobs';
import { TEST_TYPES } from '@ultimat3/testing';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'render-modes';

/** The one file allowed to declare the three ROUTE vocabularies. Each other set names its own. */
export const VOCABULARY_MODULE = 'packages/core/src/route-vocabulary.ts';

/** Which package a module belongs to, so a finding can name the import a reader would write. */
const packageOf = (module: string): string => `@ultimat3/${module.split('/')[1] ?? ''}`;

export interface Vocabulary {
  readonly name: string;
  /** The ONE module allowed to declare it, and the module a finding tells the reader to import. */
  readonly at: string;
  readonly members: readonly string[];
  /**
   * How a second declaration is recognised, and it is NOT one rule for all six.
   *
   * `members` compares the literal SET, which is what catches a copy under another name —
   * `PwaRenderMode` is why this file exists. It only works where the members are distinctive:
   * `isr`, `precache`, `interaction` appear nowhere else in the tree.
   *
   * `name` compares the identifier, which is what a vocabulary of ordinary English words needs.
   * Measured 2026-08-22: comparing `JOB_STATES`, `TEST_TYPES` and `IMAGE_FORMATS` by members
   * reports ELEVEN sets that are legitimately related and not copies — `SERIAL_TYPES` (a subset of
   * the test types), `ENCODABLE_FORMATS` (what the static codecs write), `VERIFY_STEP_NAMES` (a
   * superset by construction). A rule reporting those is one readers learn to silence, which is
   * this file's own stated reason for `COPY_THRESHOLD`. It still catches the copy that mattered:
   * `packages/core/src/image/probe.ts` exports `IMAGE_FORMATS` under that exact name.
   */
  readonly by: 'members' | 'name';
}

/**
 * Imported, never re-typed here: a check that restated the members would be the thirteenth copy.
 * The unions are derived from these arrays in the module itself, so there is no separate type to
 * compare — that half of the old failure mode is gone by construction.
 *
 * Fourteen declarations of these three sets lived across six packages, and they were not a style
 * problem: `'spa'` was deleted from `RENDER_MODES` and the repo typechecked green project-wide
 * with five copies still admitting it, `@ultimat3/pwa` mapping it to `cache-first` — the one
 * strategy that gives an `app/` route a SHARED cache entry. This is what stops copy #13.
 */
export const VOCABULARIES: readonly Vocabulary[] = [
  { name: 'RENDER_MODES', at: VOCABULARY_MODULE, members: [...RENDER_MODES], by: 'members' },
  {
    name: 'OFFLINE_STRATEGIES',
    at: VOCABULARY_MODULE,
    members: [...OFFLINE_STRATEGIES],
    by: 'members',
  },
  {
    name: 'HYDRATE_STRATEGIES',
    at: VOCABULARY_MODULE,
    members: [...HYDRATE_STRATEGIES],
    by: 'members',
  },
  // Three more, added 2026-08-22. Each had a copy that shipped and each was invisible here: the
  // rule only knew the route vocabulary, so `packages/cli/src/jobs-report.ts`'s `JOB_STATES` copy
  // — one member short, so `x jobs cancel` created a state `x jobs ls --state cancelled` refused
  // to filter on — was outside its reach by construction.
  { name: 'JOB_STATES', at: 'packages/jobs/src/driver.ts', members: [...JOB_STATES], by: 'name' },
  {
    name: 'TEST_TYPES',
    at: 'packages/testing/src/test-types.ts',
    members: [...TEST_TYPES],
    by: 'name',
  },
  // TWO pairs are deliberately absent, both for the same reason: each is a genuine divergence
  // whose resolution is a DECISION nobody has made, and a gate that reds a known-bad pair with no
  // edit that clears it is the one thing a gate must never be.
  //
  //   IMAGE_FORMATS — `packages/core/src/image/probe.ts` exports png|jpeg|webp|avif|gif|svg and
  //   `packages/storage/src/image.ts` exports avif|webp|jpeg|png, under the SAME name, both from
  //   their package barrels, with `ImageFormat` spelled twice to match. Found 2026-08-22 by this
  //   very widening. They are different concepts — what core can PROBE against what storage can
  //   TRANSFORM — so the fix is a rename plus a breaking barrel change, not an import.
  //
  //   CacheTier (`core`: memo|lru|shared|isr|cdn) against TierName (`cache`:
  //   request-memo|lru|redis|cdn) — issue #293. Two shared members, which is this rule's own
  //   threshold, and `isr` is accepted by config and served by nothing.
  //
  // Add each row the day its decision lands. `IMAGE_FORMATS` is imported above so the row is one
  // uncommented line: `{ name: 'IMAGE_FORMATS', at: <winner>, members: [...IMAGE_FORMATS], by:
  // 'name' }`.
];

/**
 * Shared members before a literal set counts as a copy. ONE is a coincidence between vocabularies
 * that genuinely differ — `CacheTier` includes `'isr'`, `StrategyName` includes `'network-only'` —
 * and reporting either would be a rule its readers learn to silence. TWO has no innocent example
 * in this repo, and a partial copy (`'static' | 'isr' | 'ssr'`, the drift shape) still trips it.
 */
export const COPY_THRESHOLD = 2;

export interface LiteralSet {
  readonly name: string;
  readonly line: number;
  readonly members: readonly string[];
}

export interface SourceFile {
  readonly at: string;
  readonly text: string;
}

export interface Finding {
  readonly at: string;
  readonly cause: string;
  readonly fix: string;
}

const LITERAL = /(['"])([^'"]*)\1/g;
// `^[\t ]*` and not `^`: a declaration nested in a namespace or a block is indented, and a guard
// a newline evades is not a guard. `\s*=` for the same reason — Biome wraps a long one.
const UNION = /^[\t ]*(?:export )?(?:declare )?type ([A-Za-z_$][\w$]*)\s*=([^;]*);/gm;
const AS_CONST =
  /^[\t ]*(?:export )?(?:declare )?const ([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]\s*as const;/gm;
/**
 * The same array with a TYPE ANNOTATION instead of `as const` — `const X: readonly JobState[] = […]`
 * — which is the shape `packages/cli/src/jobs-report.ts`'s `JOB_STATES` copy was written in, and
 * which the `as const` rule above reads as no declaration at all. A bare `const X = ['a','b'];` is
 * deliberately still not read: it is any array of strings, not a vocabulary asserting itself.
 */
const TYPED_ARRAY =
  /^[\t ]*(?:export )?(?:declare )?const ([A-Za-z_$][\w$]*)\s*:\s*(?:readonly\s+)?[\w$.]+\[\]\s*=\s*\[([^\]]*)\];/gm;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * Whether the declaration `decl` found at `index` is CODE, asked of `maskLiterals`' output — where
 * a string's contents are blanked and every offset is preserved, so the keyword survives exactly
 * when it was never inside one. `@ultimat3/cli`'s scaffold templates emit route source as strings,
 * and reading one of those as a declaration invents a finding no edit can clear.
 */
const isCode = (masked: string, index: number, decl: string): boolean =>
  masked[index + (decl.length - decl.trimStart().length)] !== ' ';

const membersOf = (body: string): readonly string[] =>
  [...body.matchAll(LITERAL)].map((match) => match[2] as string);

/** Whether the body is string literals and separators and nothing else. */
const closedSet = (body: string, separators: RegExp): boolean =>
  body.replace(LITERAL, '').replace(separators, '').trim() === '';

/**
 * Every closed set of string literals a file declares, read as TEXT — `type NAME = 'a' | 'b';` and
 * `const NAME = ['a', 'b'] as const;`, at any indentation, with an optional `export`/`declare`.
 *
 * Read from `stripComments` so a doc comment BETWEEN two members does not make the set unreadable
 * (`RoundingMode` and `VERIFY_STEP_NAMES` are both written that way), and positioned against
 * `maskLiterals` so a set quoted inside a template literal is not read as a declaration.
 *
 * What it still does NOT understand, and therefore what needs review rather than a green check: a
 * set built from another type (`keyof typeof X`, `Exclude<…>`), an array without `as const`,
 * backtick members, an `enum`, and an object literal's keys. Those are silence, not findings — the
 * vacuity guard below is what keeps that silence from becoming the whole answer.
 */
export function scanLiteralSets(source: string): readonly LiteralSet[] {
  const text = stripComments(source);
  const masked = maskLiterals(source);
  const found: LiteralSet[] = [];
  for (const [pattern, separators] of [
    [UNION, /[|\s]/g],
    [AS_CONST, /[,\s]/g],
    [TYPED_ARRAY, /[,\s]/g],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      if (!isCode(masked, match.index, match[0] as string)) continue;
      const body = match[2] as string;
      if (!closedSet(body, separators)) continue;
      const members = membersOf(body);
      if (members.length < COPY_THRESHOLD) continue;
      found.push({ name: match[1] as string, line: lineOf(text, match.index), members });
    }
  }
  return found;
}

const overlap = (set: LiteralSet, vocabulary: Vocabulary): readonly string[] =>
  set.members.filter((member) => vocabulary.members.includes(member));

/** Whether this set, declared outside the owning module, is a second declaration of `vocabulary`. */
const isCopy = (set: LiteralSet, vocabulary: Vocabulary): boolean =>
  vocabulary.by === 'name'
    ? set.name === vocabulary.name
    : overlap(set, vocabulary).length >= COPY_THRESHOLD;

const copyFinding = (file: SourceFile, set: LiteralSet, vocabulary: Vocabulary): Finding => ({
  at: `${file.at}:${set.line}`,
  cause: `${set.name} in ${file.at} redeclares ${vocabulary.name}, which ${vocabulary.at} declares`,
  fix: `delete ${set.name} from ${file.at} and import ${vocabulary.name} from '${packageOf(vocabulary.at)}' — the set is declared once, in ${vocabulary.at}`,
});

const vacuous = (cause: string): Finding => ({
  at: 'scripts/render-modes.ts',
  cause,
  fix: 'fix the scan in scripts/render-modes.ts, or point VOCABULARY_MODULE at the file that declares the vocabulary',
});

/**
 * The whole rule. The sanctioned module is checked FIRST and in the opposite direction: it must
 * declare every vocabulary, by name. A scanner that silently read nothing would otherwise report
 * a repo with no copies — which is the same answer as a repo with twelve, and the reason the old
 * version of this check needed a non-vacuity guard too.
 */
export function checkVocabulary(files: readonly SourceFile[]): readonly Finding[] {
  if (files.length === 0) return [vacuous('the scan walked no files, so no copy could be found')];
  const owned = new Set(VOCABULARIES.map((vocabulary) => vocabulary.at));
  for (const at of owned) {
    const sanctioned = files.find((file) => file.at === at);
    if (sanctioned === undefined) return [vacuous(`${at} was not among the files scanned`)];
    const declared = scanLiteralSets(sanctioned.text).map((set) => set.name);
    const missing = VOCABULARIES.filter(
      (vocabulary) => vocabulary.at === at && !declared.includes(vocabulary.name),
    );
    if (missing.length > 0) {
      return [
        vacuous(
          `${at} does not declare ${missing.map((one) => one.name).join(', ')} in a shape this scan can read`,
        ),
      ];
    }
  }

  const findings: Finding[] = [];
  for (const file of files) {
    for (const set of scanLiteralSets(file.text)) {
      for (const vocabulary of VOCABULARIES) {
        // A module is skipped only for the vocabularies IT owns: `route-vocabulary.ts` declares
        // three, and a fourth set appearing there would still be a copy.
        if (file.at === vocabulary.at && set.name === vocabulary.name) continue;
        if (isCopy(set, vocabulary)) findings.push(copyFinding(file, set, vocabulary));
      }
    }
  }
  return findings;
}

/**
 * Shipped source only. A test fixture spelling a vocabulary out is INPUT to the code under test,
 * never a declaration anything imports — the same rule `scripts/test-bare-error.ts` applies to a
 * `new Error` a test hands to its subject. An app's own source is likewise not the framework's.
 */
export const SOURCE_GLOB = 'packages/*/src/**/*.{ts,tsx}';

const isTest = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);

export async function readSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(SOURCE_GLOB).scan({ cwd: root })) {
    if (isTest(path) || path.includes('/dist/')) continue;
    files.push({ at: path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return files.sort((a, b) => a.at.localeCompare(b.at));
}

export const vocabularyFindings = async (root: string): Promise<readonly Finding[]> =>
  checkVocabulary(await readSources(root));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const files = await readSources(root);
  const findings = checkVocabulary(files);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${files.length} files, one declaration each of ${VOCABULARIES.map((one) => one.name).join(', ')}`
          : `${findings.length} second declaration(s) of a closed vocabulary`,
      lines: findings.map((one) => `  ${one.at}\n    cause: ${one.cause}\n    fix:   ${one.fix}`),
      data: { scanned: files.length, findings },
    },
    args.json,
  );
}
