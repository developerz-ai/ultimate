#!/usr/bin/env bun
// One rule: NOTHING outside `packages/core/src/route-vocabulary.ts` may declare the route
// vocabulary. Twelve declarations of three closed sets lived across six packages until they were
// consolidated into tier 0, and the copies were not a style problem — `'spa'` was deleted from
// `RENDER_MODES` and the repo typechecked green project-wide with five copies still admitting it,
// `@ultimat3/pwa` mapping it to `cache-first`, the one strategy that gives an `app/` route a
// SHARED cache entry. This is what stops copy #13.
//
// It compares LITERAL SETS, not names, because the copy that did the damage was called
// `PwaRenderMode`: a rule keyed on the word `RenderMode` would have read straight past it.
//
//   bun run scripts/render-modes.ts [--json]

import { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'render-modes';

/** The one file allowed to declare any of them, and the fix line every finding points at. */
export const VOCABULARY_MODULE = 'packages/core/src/route-vocabulary.ts';

export interface Vocabulary {
  readonly name: string;
  readonly members: readonly string[];
}

/**
 * Imported, never re-typed here: a check that restated the members would be the thirteenth copy.
 * The unions are derived from these arrays in the module itself, so there is no separate type to
 * compare — that half of the old failure mode is gone by construction.
 */
export const VOCABULARIES: readonly Vocabulary[] = [
  { name: 'RENDER_MODES', members: [...RENDER_MODES] },
  { name: 'OFFLINE_STRATEGIES', members: [...OFFLINE_STRATEGIES] },
  { name: 'HYDRATE_STRATEGIES', members: [...HYDRATE_STRATEGIES] },
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
const UNION = /^(?:export )?type ([A-Za-z_$][\w$]*) =([^;]*);/gm;
const AS_CONST = /^(?:export )?const ([A-Za-z_$][\w$]*) = \[([^\]]*)\] as const;/gm;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const membersOf = (body: string): readonly string[] =>
  [...body.matchAll(LITERAL)].map((match) => match[2] as string);

/** Whether the body is string literals and separators and nothing else. */
const closedSet = (body: string, separators: RegExp): boolean =>
  body.replace(LITERAL, '').replace(separators, '').trim() === '';

/**
 * Every closed set of string literals a file declares at column 0, read as TEXT.
 *
 * What it understands: `type NAME = 'a' | 'b';` and `const NAME = ['a', 'b'] as const;`, each with
 * an optional `export` and starting at column 0.
 *
 * What it does NOT understand — and therefore what a determined copier could still hide a set in:
 * an INDENTED or nested declaration, a set built from another type (`keyof typeof X`, `Exclude<…>`),
 * an array without `as const`, backtick literals, an object literal's keys, and a set spelled
 * inside a template literal (`@ultimat3/cli`'s route templates emit source as strings). Those are
 * silence, not findings, because a scan over one file cannot tell a declaration from a quotation —
 * the vacuity guard below is what keeps that silence from becoming the whole answer.
 */
export function scanLiteralSets(source: string): readonly LiteralSet[] {
  const found: LiteralSet[] = [];
  for (const [pattern, separators] of [
    [UNION, /[|\s]/g],
    [AS_CONST, /[,\s]/g],
  ] as const) {
    for (const match of source.matchAll(pattern)) {
      const body = match[2] as string;
      if (!closedSet(body, separators)) continue;
      const members = membersOf(body);
      if (members.length < COPY_THRESHOLD) continue;
      found.push({ name: match[1] as string, line: lineOf(source, match.index), members });
    }
  }
  return found;
}

const overlap = (set: LiteralSet, vocabulary: Vocabulary): readonly string[] =>
  set.members.filter((member) => vocabulary.members.includes(member));

const copyFinding = (file: SourceFile, set: LiteralSet, vocabulary: Vocabulary): Finding => ({
  at: `${file.at}:${set.line}`,
  cause: `${set.name} in ${file.at} redeclares ${vocabulary.name}, which is declared at tier 0`,
  fix: `delete ${set.name} from ${file.at} and import it from '@ultimat3/core' — the set is declared once, in packages/core/src/route-vocabulary.ts`,
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
  const sanctioned = files.find((file) => file.at === VOCABULARY_MODULE);
  if (sanctioned === undefined) {
    return [vacuous(`${VOCABULARY_MODULE} was not among the files scanned`)];
  }
  const declared = scanLiteralSets(sanctioned.text);
  const missing = VOCABULARIES.filter(
    (vocabulary) => !declared.some((set) => set.name === vocabulary.name),
  );
  if (missing.length > 0) {
    return [
      vacuous(
        `${VOCABULARY_MODULE} does not declare ${missing.map((one) => one.name).join(', ')} in a shape this scan can read`,
      ),
    ];
  }

  const findings: Finding[] = [];
  for (const file of files) {
    if (file.at === VOCABULARY_MODULE) continue;
    for (const set of scanLiteralSets(file.text)) {
      for (const vocabulary of VOCABULARIES) {
        if (overlap(set, vocabulary).length >= COPY_THRESHOLD) {
          findings.push(copyFinding(file, set, vocabulary));
        }
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
          : `${findings.length} second declaration(s) of the route vocabulary`,
      lines: findings.map((one) => `  ${one.at}\n    cause: ${one.cause}\n    fix:   ${one.fix}`),
      data: { scanned: files.length, findings },
    },
    args.json,
  );
}
