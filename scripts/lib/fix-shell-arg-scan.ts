// What "a shell command position" IS, for `scripts/fix-shell-arg.ts`. The rule owns what it does
// with a finding; this file owns the reading of one line of a `fix:` template. Text only, no policy.

import { balancedClose } from './balanced-paren';

/**
 * The command words a `fix:` line in this tree actually opens with. A closed list, deliberately:
 * "a word followed by a space" is every sentence in English, and a rule that reds every prose fix
 * is a rule an agent deletes. `wiki/CLI-Reference.md` and the `doc-commands` rule already hold the
 * `x` half; the rest are what a `fix:` tells an operator to run.
 */
export const COMMAND_WORDS: readonly string[] = [
  'x',
  'bun',
  'bunx',
  'npm',
  'npx',
  'node',
  'curl',
  'wget',
  'psql',
  'createdb',
  'dropdb',
  'git',
  'gh',
  'docker',
  'helm',
  'kubectl',
  'sh',
  'bash',
  'redis-cli',
  'openssl',
  'ssh',
  'rm',
  'mv',
  'cp',
  'sed',
  'chmod',
];

/**
 * A command word OPENING a segment, and the text between it and the substitution.
 *
 * The second group is what makes the rule quiet enough to survive: an em dash, an opening
 * parenthesis or a comma between the word and the `${…}` means the line is DESCRIBING a command
 * rather than building one — `run x verify — it names ${count} findings` is prose with a command
 * word in it, and reporting it is how a rule gets switched off.
 */
const COMMAND_SEGMENT = new RegExp(`^\\s*(${COMMAND_WORDS.join('|')})(?![\\w-])([^]*)$`);

/** Between the command word and the substitution: any of these and the line is prose. */
const PROSE_MARKERS = /[—(,]/;

/** What opens a new shell segment: the template's own backtick, a pipe, a `;`, a `&&`, a `(`. */
const SEGMENT_OPENERS = ['`', '|', ';', '&', '('];

/**
 * A substitution sitting DIRECTLY after a shell operator, which makes the value itself the command
 * word rather than an argument to one. `$(` is here and a bare `(` is not: `(after editing ${file})`
 * is a parenthetical in prose, and `$(` is the only spelling that opens a subshell.
 */
const OPERATOR_TAIL = /(\|\||&&|\||;|\$\()\s*$/;

/**
 * Whether the operator ending `prefix` is a shell operator at all.
 *
 * A `|` or `;` OPENING a quoted fragment is a MARKDOWN TABLE cell, not a pipe — measured, and it
 * was three of the four operator-position hits on the first run: `the row starting "| ${n} |"` in
 * `scripts/roadmap.ts:144` and `` add a `| `${dir}` | ${tier} | … ` `` in
 * `scripts/package-map-graph.ts:342` are both instructions to edit a markdown row.
 *
 * `$(` is exempt from that test and is always a command substitution: `export KEY="$(${value})"`
 * has a quote directly in front of it and runs the value, which is the whole point of the form.
 */
const shellOperator = (prefix: string): boolean => {
  const match = OPERATOR_TAIL.exec(prefix);
  if (match === null) return false;
  if (match[1] === '$(') return true;
  const before = prefix.slice(0, match.index).trimEnd();
  return !['"', "'", '`'].includes(before.at(-1) ?? '');
};

/** A `#` earlier on the line opens a shell comment, and nothing after one runs. */
const commented = (prefix: string): boolean => prefix.includes('#');

/**
 * The command word this substitution is an argument to, or `undefined` when the text in front of it
 * is not a command at all.
 *
 * `prefix` is the ORIGINAL source between the start of the line and the `${` — original, not the
 * mask, because the mask blanks a template's TEXT and the text is the whole question here.
 */
export function commandPositionOf(prefix: string): string | undefined {
  if (commented(prefix)) return undefined;
  if (shellOperator(prefix)) return 'a shell operator';
  const openers = SEGMENT_OPENERS.map((one) => prefix.lastIndexOf(one));
  const segment = prefix.slice(Math.max(...openers) + 1);
  const match = COMMAND_SEGMENT.exec(segment);
  if (match === null) return undefined;
  return PROSE_MARKERS.test(match[2] as string) ? undefined : (match[1] as string);
}

/**
 * Calls that make a value safe to read as one shell word, so a substitution wrapped in one is
 * screened rather than spliced. `renderFixShellArg` is `@ultimat3/core`'s and is the repair every
 * finding names; `shellInertIdentifier` is `@ultimat3/db`'s and `quoteArg` is `@ultimat3/cli`'s.
 *
 * `renderFixLiteral` is on this list and it is the list's weakest joint, stated rather than hidden:
 * `packages/core/src/error-render.ts:200` says in as many words that it "does not cover this and
 * cannot be made to" — it answers `JSON.stringify`, i.e. DOUBLE quotes, in which `$(…)`, a backtick
 * and `${…}` are all still live in every POSIX shell. It is accepted here because a value that has
 * been through it is at least a deliberate render rather than a raw splice, and because the
 * alternative on day one was a wider ratchet rather than a smaller one. Narrowing this list is the
 * next tightening, and it can only make the counts BIGGER.
 */
export const SCREENING_CALLS: readonly string[] = [
  'renderFixShellArg',
  'renderFixLiteral',
  'shellInertIdentifier',
  'quoteArg',
];

const SCREENED = new RegExp(`^\\s*(?:${SCREENING_CALLS.join('|')})\\s*\\(`);

/**
 * Whether the substitution's own body is a call to one of the screening renderers, AND NOTHING
 * ELSE.
 *
 * The whole body, never the prefix: `${renderFixShellArg(path, '<the path>') + suffix}` opens with
 * an approved call and puts `suffix` straight into the command position behind it, so a prefix test
 * skipped a reachable splice. An END anchor alone does not close it either — `renderFixShellArg(a,
 * b) + f(c)` ends in `)` too — which is why the call's own `(` is walked to its match and the
 * remainder has to be empty.
 */
export const isScreened = (body: string): boolean => {
  const head = SCREENED.exec(body);
  if (head === null) return false;
  const close = balancedClose(body, (head[0] as string).length - 1);
  return close !== -1 && body.slice(close + 1).trim() === '';
};
