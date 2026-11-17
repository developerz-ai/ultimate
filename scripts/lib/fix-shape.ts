// What a `fix:` line is, read off how it OPENS: a command to run, a code shape to paste, an edit at
// a file and line, or prose.
// Text only — `scripts/fix-prose.ts` owns what a prose fix costs. The opening is the whole test,
// deliberately: a fix is pasted from its first character, and a sentence that names a command in
// its middle (`run x verify — it names the step`) is still a sentence the reader has to translate.

import { COMMAND_WORDS } from './fix-shell-arg-scan';

export type FixShape = 'command' | 'code' | 'edit' | 'prose' | 'unknown';

/**
 * `fix-shell-arg`'s command words, plus the shell builtins and tools a `fix:` in this tree opens
 * with. A closed list for the reason that one gives: "a word followed by a space" is all of English.
 */
const RUNNABLE: ReadonlySet<string> = new Set([
  ...COMMAND_WORDS,
  'cd',
  'export',
  'mkdir',
  'cat',
  'ls',
  'grep',
  'kill',
  'ps',
  'pg_dump',
  'pg_restore',
  'echo',
  'printf',
  'env',
  'tar',
  'ln',
  'nats',
  'biome',
  'tsc',
  'jq',
  // A byte count and a content sniff: `wc -c <key file>`, `file <image>` — each the measurement a
  // refusal's fix hands over.
  'wc',
  'file',
  // The clock-skew check an id token's `iat`/`exp` refusal hands over.
  'timedatectl',
]);

/** A repo script or a relative executable: `bin/check`, `./bin/probe`, `scripts/x.sh`. */
const PATH_COMMAND = /^(?:\.{0,2}\/|bin\/|scripts\/)[\w./-]+$/;
/**
 * `find <path> -<flag> …` — not a RUNNABLE word, because "find the row the cause names" is how a
 * sentence opens too. A path and then a flag (or a substituted predicate) is the command; a path
 * and then a word is English.
 */
const FIND = /^find\s+\S+\s+(?:-[a-z]|\$\{)/;
/** `NAME=value` opening the line, as the environment prefix of a command. */
const ENV_PREFIX = /^[A-Z_][A-Z0-9_]*=/;

const DECLARATION = /^(?:import|export|const|let|type|interface|function|class)\s/;
/** `key: value` where the value is code: a literal, a bracket, a call. `Note: the …` is not. */
const MEMBER = /^[a-z_$][\w$]*\??\s*:\s*(?:[{['"`(\d]|true\b|false\b|null\b|[A-Za-z_$][\w$.]*\()/;
/** One `${…}` substitution, as the scan reads a template literal: its value is a path or a line. */
const SUB = String.raw`\$\{[^}]+\}`;
/**
 * One segment of a call's dotted receiver: a name, or a substitution standing for one —
 * `db.${entity}.find(id)` and `${entityName}.findById(id)` are pasteable calls whose receiver the
 * thrower knows and the text does not.
 */
const SEGMENT = String.raw`(?:${SUB}|[A-Za-z_$][\w$]*)`;
/** A call, `new X(…)` or `await …(…)` — `word(` with no space, which prose does not write. */
const CALL = new RegExp(String.raw`^(?:await\s+|new\s+)?${SEGMENT}(?:\.${SEGMENT})*(?:<[^>]*>)?\(`);
/**
 * `edit <file>.<ext>:<line> — <instruction>`: the error contract's "an edit naming a file", opened
 * at that line. The extension and the line number are what make it a place and not a sentence —
 * `edit the config — …` is still prose.
 */
const EDIT = new RegExp(
  String.raw`^edit\s+(?:[\w@./-]*\w\.[A-Za-z]{1,6}|${SUB}):(?:\d+|${SUB})\s+—\s+\S`,
);
/**
 * `case <literal or name>:` — the arm an exhaustive switch is missing. One literal or one dotted
 * name before the colon, so `case by case: …` stays prose.
 */
const CASE = /^case\s+(?:'[^']*'|"[^"]*"|-?\d[\w.]*|[A-Za-z_$][\w$.]*)\s*:/;
/**
 * A tagged template, `sql\`select …\`` — the identifier IMMEDIATELY followed by its backtick (or the
 * escaped one the scan reads out of a template literal), so `use \`x dev\`` stays prose.
 */
const TAGGED = /^[A-Za-z_$][\w$.]*\\?`/;
const SQL =
  /^(?:ALTER|CREATE|DROP|SELECT|INSERT|UPDATE|DELETE|GRANT|REVOKE|VACUUM|REINDEX|ANALYZE|TRUNCATE)\b/;

/**
 * The shape of one fix as written, `${…}` substitutions included. A fix OPENING with a substitution
 * is computed at run time, and its shape is the value's, which text cannot know: `unknown` — unless
 * the substitution is the receiver of a call (`${entityName}.findById(id)`), which is code.
 */
export function fixShape(fix: string): FixShape {
  const text = fix.trim().replace(/^`/, '');
  // A substituted receiver followed by a call is still a call; anything else opening with one is
  // the value's shape, which text cannot know.
  if (text.startsWith('${')) return CALL.test(text) ? 'code' : 'unknown';
  const first = text.split(/\s+/)[0] ?? '';
  if (
    RUNNABLE.has(first) ||
    PATH_COMMAND.test(first) ||
    ENV_PREFIX.test(first) ||
    FIND.test(text)
  ) {
    return 'command';
  }
  if (EDIT.test(text)) return 'edit';
  if (
    CALL.test(text) ||
    DECLARATION.test(text) ||
    /^[{[]/.test(text) ||
    /^<[A-Z]/.test(text) ||
    MEMBER.test(text) ||
    CASE.test(text) ||
    TAGGED.test(text) ||
    SQL.test(text)
  ) {
    return 'code';
  }
  return 'prose';
}
