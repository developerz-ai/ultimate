// The `content` rule of `scripts/image-contract.ts`: every `*.dockerignore` drops tests and the root
// `docs/`. `COPY . .` sits above each image's slowest line, so an edit to a file no boot reads still
// reruns it, and nothing but this rule notices a tracked app's ignore file losing a line.

import { renderFixShellArg } from '@ultimat3/core';
import type { IgnoreFile } from '../image-contract';
import type { Finding } from './log';

/**
 * Each exact line, and where it must keep applying. `docs` is anchored and stays anchored: a package
 * may hold a directory of that name it reads at run time. No fixture line: non-test source can reach
 * a fixture, and a missing module at boot is a worse failure than a few kilobytes.
 */
const RULES = [
  { line: '**/*.test.ts', within: '**/*.test.ts', paths: ['x.test.ts', 'apps/web/x.test.ts'] },
  { line: '**/*.test.tsx', within: '**/*.test.tsx', paths: ['x.test.tsx', 'apps/web/x.test.tsx'] },
  { line: 'docs', within: 'docs/**', paths: ['docs', 'docs/x.md'] },
] as const;

export const CONTENT_IGNORE_LINES: readonly string[] = RULES.map((rule) => rule.line);

/** An ignore file that lets a line of `CONTENT_IGNORE_LINES` reach a layer. */
export interface ContentGap {
  readonly file: string;
  readonly missing: readonly string[];
}

/** One path a glob matches: each wildcard filled in, the first of each `{a,b}` taken. */
const instanceOf = (glob: string): string =>
  glob
    .replaceAll(/\{([^,}]*)[^}]*\}/g, '$1')
    .replaceAll(/\[[^\]]*\]/g, 'x')
    .replaceAll('**', 'a/b')
    .replaceAll(/[*?]/g, 'x');

/**
 * Whether a re-include undoes the rule rather than bringing one file back. A literal path is the
 * documented escape; a GLOB reaching into the class is not, wherever it points: fixed probes alone
 * passed `!packages/**\/*.test.ts`, which re-includes every package test. Docker anchors every
 * pattern at the context root, so a leading `/` or `./` changes nothing and is dropped first.
 */
const undoes = (pattern: string, rule: (typeof RULES)[number]): boolean => {
  const anchored = pattern.replace(/^\.?\//, '');
  const glob = new Bun.Glob(anchored);
  if (rule.paths.some((path) => glob.match(path))) return true;
  return /[*?[{]/.test(anchored) && new Bun.Glob(rule.within).match(instanceOf(anchored));
};

/** Ordered, as Docker reads it: the last line that matches decides. */
export const unignoredContentOf = (text: string): readonly string[] => {
  const lines = text
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return RULES.filter((rule) => {
    let ignored = false;
    for (const line of lines) {
      if (line === rule.line) ignored = true;
      else if (line.startsWith('!') && undoes(line.slice(1).trim(), rule)) ignored = false;
    }
    return !ignored;
  }).map((rule) => rule.line);
};

export const checkContentIgnores = (files: readonly IgnoreFile[]): readonly ContentGap[] =>
  files.flatMap((one) => {
    const missing = unignoredContentOf(one.text);
    return missing.length === 0 ? [] : [{ file: one.file, missing }];
  });

export const contentGapFindingFor = (gap: ContentGap): Finding => {
  const lines = gap.missing.map((line) => `'${line}'`).join(' ');
  return {
    code: 'X_IMAGE_CONTENT_UNIGNORED',
    cause: `${gap.file} does not ignore ${gap.missing.join(', ')}, so a build stage's \`COPY . .\` carries files no boot reads and an edit to one reruns every line below it, the prebuilt step included`,
    fix: `printf '%s\\n' ${lines} >> ${renderFixShellArg(gap.file, 'Dockerfile.dockerignore')} && bun run scripts/image-contract.ts --json`,
    at: gap.file,
  };
};
