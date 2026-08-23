// The other half of the citation rule: a `fix:` may name a FILE, and nothing resolved it. Only
// `x <command>` citations were checked (`fix-command.ts`), so a fix telling its reader to open a
// path that no longer exists — or never did — satisfied every gate the repo has, while a file token
// is one of the four things that make a fix an instruction at all (`COMMAND_TOKENS`).

// why: Bun exposes no synchronous existence primitive — `Bun.file(p).exists()` is async and answers
// false for a DIRECTORY, and this rule has to judge both. Delete when Bun ships one.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join or dirname primitive. The same necessity `error-contract.ts`
// already records for `join`.
import { dirname, join } from 'node:path';

/**
 * The extensions a fix line may cite a file by — the SAME set `COMMAND_TOKENS`' file pattern is
 * built from, exported here so the token that lets a fix count as an instruction and the token this
 * rule resolves can never drift apart. Two lists would mean a citation that satisfies the first
 * rule and is invisible to the second, which is the hole this file exists to close.
 */
export const CITED_FILE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'json',
  'md',
  'toml',
  'yaml',
  'yml',
  'css',
  'scss',
  'sql',
] as const;

/** `[\w.@-]*\/[\w.@-]+\.(?:ts|…)`, as one source string both rules read. */
export const FILE_TOKEN_PATTERN = String.raw`[\w.@-]*\/[\w.@-]+\.(?:${CITED_FILE_EXTENSIONS.join('|')})\b`;

/**
 * A whole path, not the last two segments `FILE_TOKEN_PATTERN` matches: this rule resolves the
 * citation, so it needs every segment. `*` is in the class because a glob is a citation too.
 */
const PATH_CITATION = new RegExp(
  String.raw`(?:[\w.@*-]+\/)+[\w.@*-]+\.(?:${CITED_FILE_EXTENSIONS.join('|')})\b`,
  'g',
);

/** A URL is not a repo path, and `https://ultimate.dev/errors/x.md` is shaped like one. */
const URL_SPAN = /\b[a-z][\w+.-]*:\/\/\S+/gi;

/**
 * Whether this repo can judge the citation at all. THREE exclusions, each one a shape that resolves
 * against something other than the root the gate is running in — reporting any of them would be a
 * finding nobody can act on:
 *
 * - a scoped module specifier (`@ultimat3/ui/global.scss`) resolves through `node_modules`;
 * - a dot-relative path (`./global.scss`) resolves against the reader's own file, which the fix
 *   line does not name;
 * - a path whose PARENT DIRECTORY does not exist here is app-facing by construction — `src/errors.ts`
 *   means "in the package you are editing", `apps/web/server.ts` and `packages/i18n/catalogs/en.json`
 *   name directories a generated app has and this repo does not. What is left is the citation this
 *   root really can answer: a directory that exists, named as holding a file it does not hold.
 */
function isJudgeable(token: string, root: string): boolean {
  if (token.startsWith('@') || token.startsWith('./') || token.startsWith('../')) return false;
  const star = token.indexOf('*');
  // A glob's FIXED prefix is what has to exist; the segments a `*` stands for are the answer. Cut
  // at the separator before the star rather than at the star — `dirname('packages/')` is `.`, and
  // a glob whose first segment is the wildcard has no prefix to check at all.
  const cut = star === -1 ? -1 : token.lastIndexOf('/', star);
  const base = star === -1 ? dirname(token) : token.slice(0, Math.max(cut, 0));
  return base !== '.' && base !== '' && existsSync(join(root, base));
}

/** Every path-shaped citation on a fix line that this root can resolve, in the order written. */
export function pathCitations(fix: string, root: string): readonly string[] {
  const prose = fix.replaceAll(URL_SPAN, ' ');
  return [...prose.matchAll(PATH_CITATION)]
    .map((match) => match[0])
    .filter((token) => isJudgeable(token, root));
}

/** A glob matches when at least one file answers it; anything else must exist as written. */
async function resolves(token: string, root: string): Promise<boolean> {
  if (!token.includes('*')) return existsSync(join(root, token));
  for await (const _match of new Bun.Glob(token).scan({ cwd: root, onlyFiles: false })) {
    return true;
  }
  return false;
}

/**
 * The first path a fix cites that this repo does not have, as one sentence for a `cause:`. One
 * finding per fix line, never one per token — the same rule `citedCommandProblem` holds to.
 *
 * Read off the STATIC form of the fix (the caller blanks `${…}` first): a path assembled at run
 * time is not a path this can resolve, and guessing at one reports findings nobody can act on.
 */
export async function citedPathProblem(fix: string, root: string): Promise<string | undefined> {
  for (const token of pathCitations(fix, root)) {
    if (!(await resolves(token, root))) {
      const kind = token.includes('*') ? 'matches no file' : 'is not a file in this repository';
      return `cites "${token}", which ${kind}`;
    }
  }
  return undefined;
}
