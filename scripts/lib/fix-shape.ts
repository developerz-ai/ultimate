// What a `fix:` line is, read off how it OPENS: a command to run, a code shape to paste, or prose.
// Text only — `scripts/fix-prose.ts` owns what a prose fix costs. The opening is the whole test,
// deliberately: a fix is pasted from its first character, and a sentence that names a command in
// its middle (`run x verify — it names the step`) is still a sentence the reader has to translate.

import { COMMAND_WORDS } from './fix-shell-arg-scan';

export type FixShape = 'command' | 'code' | 'prose' | 'unknown';

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
  'pg_dump',
  'pg_restore',
  'echo',
  'env',
  'tar',
  'ln',
  'nats',
  'biome',
  'tsc',
  'jq',
]);

/** A repo script or a relative executable: `bin/check`, `./bin/probe`, `scripts/x.sh`. */
const PATH_COMMAND = /^(?:\.{0,2}\/|bin\/|scripts\/)[\w./-]+$/;
/** `NAME=value` opening the line, as the environment prefix of a command. */
const ENV_PREFIX = /^[A-Z_][A-Z0-9_]*=/;

/** A call, `new X(…)` or `await …(…)` — `word(` with no space, which prose does not write. */
const CALL = /^(?:await\s+|new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^>]*>)?\(/;
const DECLARATION = /^(?:import|export|const|let|type|interface|function|class)\s/;
/** `key: value` where the value is code: a literal, a bracket, a call. `Note: the …` is not. */
const MEMBER = /^[a-z_$][\w$]*\??\s*:\s*(?:[{['"`(\d]|true\b|false\b|null\b|[A-Za-z_$][\w$.]*\()/;
const SQL =
  /^(?:ALTER|CREATE|DROP|SELECT|INSERT|UPDATE|DELETE|GRANT|REVOKE|VACUUM|REINDEX|ANALYZE|TRUNCATE)\b/;

/**
 * The shape of one fix as written, `${…}` substitutions included. A fix OPENING with a substitution
 * is computed at run time, and its shape is the value's, which text cannot know: `unknown`.
 */
export function fixShape(fix: string): FixShape {
  const text = fix.trim().replace(/^`/, '');
  if (text.startsWith('${')) return 'unknown';
  const first = text.split(/\s+/)[0] ?? '';
  if (RUNNABLE.has(first) || PATH_COMMAND.test(first) || ENV_PREFIX.test(first)) return 'command';
  if (
    CALL.test(text) ||
    DECLARATION.test(text) ||
    /^[{[]/.test(text) ||
    /^<[A-Z]/.test(text) ||
    MEMBER.test(text) ||
    SQL.test(text)
  ) {
    return 'code';
  }
  return 'prose';
}
