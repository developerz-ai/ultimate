// The one editor of an app's `apps/web/exercise.ts`: entries inserted into its single
// `export const exercise = defineExercise({ … })`, read off the MASKED source (a call in a comment
// or a string is prose), printed the way Biome leaves them, each import in Biome's order. A file
// it cannot read that way is refused with the reason, never guessed at; a named entry is the app's.

import { maskOf, readList, readProperties } from './source-list-edit';
import { exerciseFiles } from './templates/scaffold-exercise';
import { wrapImport } from './templates/wrap';

/** One value an entry needs imported: `userActor` from `@ultimat3/core`. */
export interface ExerciseImport {
  readonly name: string;
  readonly from: string;
}

/**
 * One primitive's entry. `value` is its object literal printed at column 0 (`{\n  actor: …,\n}` or
 * `{ off: '…' }`); the edit indents it to where the call's properties sit.
 */
export interface ExerciseEntry {
  readonly name: string;
  readonly value: string;
  readonly imports?: readonly ExerciseImport[];
}

export type ExerciseEdit =
  | { readonly kind: 'edited' | 'unchanged'; readonly source: string }
  | { readonly kind: 'refused'; readonly reason: string };

const CALL = /\bdefineExercise\s*\(\s*/g;
const EXPORTED = /\bexport\s+const\s+exercise\s*=\s*defineExercise\s*\(/;
/** An entry's key: `name:`, `'name':`, or a shorthand `name` — read off the entry's own text. */
const KEY = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(?::|$)/;

const refused = (reason: string): ExerciseEdit => ({ kind: 'refused', reason });

/** As an object key: bare where it is an identifier, quoted where it is not (`'billing-events'`). */
export const entryKey = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;

/** `source` (or `x new`'s file when there is none) with every entry it does not name yet. */
export function editExerciseFile(
  source: string | undefined,
  entries: readonly ExerciseEntry[],
): ExerciseEdit {
  const base = source ?? String(exerciseFiles()[0]?.contents ?? '');
  const masked = maskOf(base);
  const calls = [...masked.matchAll(CALL)];
  const call = calls[0];
  if (call === undefined) return refused('holds no defineExercise() call');
  if (calls.length > 1) return refused(`holds ${calls.length} defineExercise() calls`);
  const open = call.index + call[0].length;
  if (masked[open] !== '{') {
    return refused('hands defineExercise() something other than an object literal ({ … })');
  }
  if (!EXPORTED.test(masked)) {
    return refused('does not declare it as export const exercise = defineExercise(…)');
  }
  const list = readList(base, masked, open);
  if (list === undefined) return refused('has a defineExercise({ … }) that never closes');
  const named = new Set(list.entries.map((entry) => keyOf(entry.text)));
  const missing = unique(entries).filter((entry) => !named.has(entry.name));
  if (missing.length === 0) return { kind: 'unchanged', source: base };

  const inserted = insertRows(base, masked, list, missing);
  const next = withImports(
    inserted,
    missing.flatMap((entry) => entry.imports ?? []),
  );
  return readsBack(next, missing)
    ? { kind: 'edited', source: next }
    : refused('reads back changed');
}

const keyOf = (text: string): string | undefined => {
  const found = KEY.exec(text);
  return found === null ? undefined : (found[1] ?? found[2] ?? found[3]);
};

const unique = (entries: readonly ExerciseEntry[]): readonly ExerciseEntry[] =>
  entries.filter((entry, index) => entries.findIndex((e) => e.name === entry.name) === index);

const lineIndent = (source: string, at: number): string => {
  const start = source.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? '';
};

/** `  name: value,` with every line of the value under `indent`. */
const row = (indent: string, entry: ExerciseEntry): string =>
  `${indent}${entryKey(entry.name)}: ${entry.value.split('\n').join(`\n${indent}`)},`;

function insertRows(
  source: string,
  masked: string,
  list: NonNullable<ReturnType<typeof readList>>,
  entries: readonly ExerciseEntry[],
): string {
  const outer = lineIndent(source, list.open);
  const multiline = masked.slice(list.open, list.close).includes('\n');
  const first = list.entries[0];
  // A property's own indent where one starts its line; else one step in from the brace's line.
  const startsLine =
    first !== undefined &&
    source.slice(source.lastIndexOf('\n', first.start - 1) + 1, first.start).trim() === '';
  const indent =
    multiline && startsLine && first !== undefined ? lineIndent(source, first.start) : `${outer}  `;
  const rows = entries.map((entry) => row(indent, entry));
  const closeLine = source.lastIndexOf('\n', list.close) + 1;
  const last = list.entries.at(-1);
  if (multiline && source.slice(closeLine, list.close).trim() === '') {
    // Appended as the last rows, above the closing brace's own line; the comma the old last entry
    // owes goes right after its code, before any comment beside it.
    const before = source.slice(0, closeLine);
    const head =
      last === undefined || list.trailingComma
        ? before
        : `${before.slice(0, last.end)},${before.slice(last.end)}`;
    return `${head}${rows.join('\n')}\n${source.slice(closeLine)}`;
  }
  // One line — `{}` or `{ keep: … }` — or a brace sharing its line with code: a row each, Biome's
  // expanded shape, the old entries first.
  const kept = list.entries.map((entry) => `${indent}${entry.text},`);
  const head = source.slice(0, list.open + 1);
  return `${head}\n${[...kept, ...rows].join('\n')}\n${outer}${source.slice(list.close)}`;
}

/** Every top-level `import … from '<x>';` of the source: where it spans and what it names. */
const IMPORT = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';[^\S\n]*$/gm;
const ANY_IMPORT = /^import\s[^;]*?from\s*'([^']+)';/gm;

/** Biome's groups, coarsely: builtins, then packages, then relative paths. */
const rank = (from: string): number =>
  /^(?:bun|node):/.test(from) ? 0 : from.startsWith('.') ? 2 : 1;

const before = (left: string, right: string): boolean =>
  rank(left) !== rank(right) ? rank(left) < rank(right) : left < right;

function withImports(source: string, wanted: readonly ExerciseImport[]): string {
  let next = source;
  for (const want of wanted) {
    const masked = maskOf(next);
    const statements = [...next.matchAll(IMPORT)].filter((m) => masked[m.index] === 'i');
    const named = statements.find((m) => m[1] === undefined && m[3] === want.from);
    if (named !== undefined) {
      const names = (named[2] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      if (names.includes(want.name)) continue;
      const line = wrapImport([...names, want.name], want.from);
      next = `${next.slice(0, named.index)}${line}${next.slice(named.index + named[0].length)}`;
      continue;
    }
    const all = [...next.matchAll(ANY_IMPORT)].filter((m) => masked[m.index] === 'i');
    const after = all.find((m) => before(want.from, m[1] ?? ''));
    const last = all.at(-1);
    const at = after?.index ?? (last === undefined ? 0 : last.index + last[0].length + 1);
    next = `${next.slice(0, at)}${wrapImport([want.name], want.from)}\n${next.slice(at)}`;
  }
  return next;
}

/** One call still, and every inserted name a key of it now. */
function readsBack(source: string, entries: readonly ExerciseEntry[]): boolean {
  const masked = maskOf(source);
  const calls = [...masked.matchAll(CALL)];
  const call = calls[0];
  if (calls.length !== 1 || call === undefined) return false;
  const keys = new Set(
    readProperties(source, masked, call.index + call[0].length).map((p) => p.key),
  );
  return entries.every((entry) => keys.has(entry.name));
}
