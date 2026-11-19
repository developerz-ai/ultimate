// The four registries every generated feature adds to, held one entry per line. Two branches that
// each add a feature then touch different lines, so `x merge-driver` can keep both; a list on one
// line is the same line changed twice, which no merge can tell from a real disagreement. `x new`
// writes this shape and the `registry-lines` codemod carries an existing app to it.

import { stripComments } from '@ultimat3/core';
import { apiListsOf, insertApiList } from './api-registration';
import { API_INDEX } from './app-root';
import { declarationLists } from './generate-grants';
import { ROLES_FILE } from './permission-grants';
import { maskOf, readList, readProperties } from './source-list-edit';
import { HANDLE_FILE } from './templates/scaffold-db-client';

const EXERCISE_FILE = 'apps/web/exercise.ts';

/** Inside the bracket, it is also what keeps Biome from joining the list back onto one line. */
export const REGISTRY_LINE_COMMENT =
  '// One entry per line: branches that each add one merge cleanly (x merge-driver).';

/** Every file `withRegistryLines` holds to the shape. */
export const REGISTRY_FILES: readonly string[] = [
  API_INDEX,
  ROLES_FILE,
  EXERCISE_FILE,
  HANDLE_FILE,
];

const API_LISTS = ['actions', 'queries', 'jobs', 'tasks'] as const;

const indentAt = (source: string, at: number): string =>
  /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', at) + 1))?.[0] ?? '';

const startsItsLine = (source: string, at: number): boolean =>
  source.slice(source.lastIndexOf('\n', at - 1) + 1, at).trim() === '';

/**
 * The list opening at `open`, a row per entry under the comment. A list this cannot restate
 * without moving the author's text — a comment beside entries on one line, two entries sharing a
 * row — is left as it is: it still works, it just merges by hand.
 */
export function listWithLines(source: string, open: number): string {
  const list = readList(source, maskOf(source), open);
  if (list === undefined) return source;
  const span = source.slice(list.open, list.close + 1);
  if (span.includes(REGISTRY_LINE_COMMENT)) return source;
  const indent = indentAt(source, open);
  const comment = `${indent}  ${REGISTRY_LINE_COMMENT}`;
  if (span.includes('\n')) {
    const lineEnd = source.indexOf('\n', open);
    const opensAlone = source.slice(open + 1, lineEnd).trim() === '';
    if (!opensAlone || list.entries.some((entry) => !startsItsLine(source, entry.start))) {
      return source;
    }
    return `${source.slice(0, lineEnd + 1)}${comment}\n${source.slice(lineEnd + 1)}`;
  }
  if (stripComments(source).slice(list.open, list.close + 1) !== span) return source;
  const rows = list.entries.map((entry) => `${indent}  ${entry.text},\n`).join('');
  const bracket = source[list.close] as string;
  const body = `${source[open] as string}\n${comment}\n${rows}${indent}${bracket}`;
  return `${source.slice(0, open)}${body}${source.slice(list.close + 1)}`;
}

function apiWithLines(source: string): string {
  let next = source;
  for (const key of API_LISTS) {
    // A list every branch can add to exists before either does: two branches each creating
    // `tasks:` is one key written twice, the one shape no line merge can keep.
    next = apiListsOf(next)?.(key) === undefined ? (insertApiList(next, key, '[]') ?? next) : next;
    const list = apiListsOf(next)?.(key);
    if (list !== undefined) next = listWithLines(next, list.open);
  }
  return next;
}

/** Applied from the last list back, so an edit never moves an offset still to be used. */
const eachFromLast = (source: string, opens: readonly number[]): string =>
  [...opens].sort((a, b) => b - a).reduce(listWithLines, source);

function grantLists(source: string): readonly number[] {
  const masked = maskOf(source);
  const call = /\bdefineRoles\(\s*\{/.exec(masked);
  if (call === null) return [];
  return readProperties(source, masked, call.index + call[0].length - 1).flatMap((role) => {
    if (masked[role.value] !== '{') return [];
    const grants = readProperties(source, masked, role.value).find((p) => p.key === 'grants');
    return grants !== undefined && masked[grants.value] === '[' ? [grants.value] : [];
  });
}

const rolesWithLines = (source: string): string =>
  eachFromLast(source, [...declarationLists(maskOf(source)), ...grantLists(source)]);

/** An EMPTY object only: a filled one is already a row per entry, which Biome keeps. */
function emptyObjectWithLines(source: string, opening: RegExp): string {
  const masked = maskOf(source);
  const found = opening.exec(masked);
  if (found === null) return source;
  const open = found.index + found[0].length - 1;
  const list = readList(source, masked, open);
  return list?.entries.length === 0 ? listWithLines(source, open) : source;
}

/** `source`, the registry at `path`, in the one-entry-per-line shape. Any other path: unchanged. */
export function withRegistryLines(path: string, source: string): string {
  if (path === API_INDEX) return apiWithLines(source);
  if (path === ROLES_FILE) return rolesWithLines(source);
  if (path === EXERCISE_FILE) return emptyObjectWithLines(source, /\bdefineExercise\(\s*\{/);
  if (path === HANDLE_FILE) return emptyObjectWithLines(source, /\bconst entities\s*=\s*\{/);
  return source;
}
