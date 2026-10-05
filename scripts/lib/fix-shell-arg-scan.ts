// What "a shell command position" IS, for `scripts/fix-shell-arg.ts`. The rule owns what it does
// with a finding; this file owns the reading of one line of a `fix:` template. Text only, no policy.

import { balancedClose } from './balanced-paren';
import { readShell } from './shell-reading';

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
  // Plan 101 row S12: the storage drivers' fixes reproduce a refusal with `aws s3api …`, `ls -ld`
  // and `df`, and none of the three was a word this rule knew.
  'aws',
  'ls',
  'df',
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

/**
 * A sentence handing over to a command: `…, then reproduce with: aws s3api …`. Not a segment
 * opener, because a `: ` also sits INSIDE commands (`curl -H 'accept: application/json'`) and
 * cutting there would hide the argument after it. So it is a SECOND reading, asked only when it
 * falls after the last real opener — and read with fresh quote state, because an apostrophe in the
 * sentence before it (`the app's role`) is not a quote the command opened.
 */
const PROSE_HANDOVER = ': ';

/** `NAME=value` and `sudo` in front of the command word are part of the command, not prose. */
const TRANSPARENT = /^\s*(?:(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S)*|sudo)\s+)*/;

/** A substitution that IS an assignment's value at the segment start: `DATABASE_URL=${url} x …`. */
const ASSIGNMENT_VALUE = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*[A-Za-z_]\w*=\S*$/;

/** The command a segment opens — past any `NAME=value` / `sudo` — unless prose follows the word. */
function commandOpening(segment: string): string | undefined {
  if (ASSIGNMENT_VALUE.test(segment)) return 'an environment assignment';
  const lead = TRANSPARENT.exec(segment)?.[0] ?? '';
  const match = COMMAND_SEGMENT.exec(segment.slice(lead.length));
  if (match === null) return undefined;
  return readShell(match[2] as string).prose.length > 0 ? undefined : (match[1] as string);
}

/** The command opened by the last segment of `text`, read from `text`'s own start. */
function lastSegmentCommand(text: string): { readonly command?: string; readonly opener: number } {
  const reading = readShell(text);
  if (reading.commented) return { opener: Number.POSITIVE_INFINITY };
  const command = commandOpening(text.slice(reading.opener + 1));
  return command === undefined ? { opener: reading.opener } : { command, opener: reading.opener };
}

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

/**
 * The command word this substitution is an argument to, or `undefined` when the text in front of it
 * is not a command at all.
 *
 * `prefix` is the ORIGINAL source between the start of the line and the `${` — original, not the
 * mask, because the mask blanks a template's TEXT and the text is the whole question here.
 */
export function commandPositionOf(prefix: string): string | undefined {
  // The template's own backtick (or an escaped one, a markdown code span) opens the text; what
  // stands before it is code, whose quotes are not the command's.
  const text = prefix.slice(prefix.lastIndexOf('`') + 1);
  const direct = lastSegmentCommand(text);
  if (direct.opener === Number.POSITIVE_INFINITY) return undefined;
  if (shellOperator(prefix)) return 'a shell operator';
  if (direct.command !== undefined) return direct.command;
  const handover = text.lastIndexOf(PROSE_HANDOVER);
  if (handover <= direct.opener) return undefined;
  return lastSegmentCommand(text.slice(handover + PROSE_HANDOVER.length)).command;
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
  // Plan 101 row S12. Each is a screen for a DOUBLE-QUOTED shell word: `JSON.stringify`, with a
  // value carrying `$`, a backtick or `!` replaced by its placeholder. `migrationNameArg`
  // (`packages/db/src/primary-key.ts`) for `x db gen "<name>"`, whose argument is a description
  // with spaces no single-word screen can carry; `rerunFileArgs` (`packages/testing/src/registry-leak-error.ts`)
  // for the leaked files a `bun test` re-run names. Each has a hostile-value test beside it.
  'migrationNameArg',
  'rerunFileArgs',
  // `packages/render/src/registry.ts`'s POSIX single-quoter (`'\''` for a quote), behind `--`.
  // Surfaced when constructor sinks were read (security audit of plan 101 sweep 1c, M1).
  'shellQuote',
];

const screenOpening = (calls: readonly string[]): RegExp =>
  new RegExp(`^\\s*(?:${calls.join('|')})\\s*\\(`);

const SCREENED = screenOpening(SCREENING_CALLS);

/**
 * The calls a `const` may be bound to and still vouch for its name wherever it is spliced. Not
 * `renderFixLiteral`: its own doc (`packages/core/src/error-render.ts`) says it is not a shell
 * screen, and a binding carries it away from the quoting context that made one call site sound.
 */
const SHELL_SCREENED = screenOpening(SCREENING_CALLS.filter((call) => call !== 'renderFixLiteral'));

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
const screenedBy = (opening: RegExp, body: string): boolean => {
  const head = opening.exec(body);
  if (head === null) return false;
  const close = balancedClose(body, (head[0] as string).length - 1);
  return close !== -1 && body.slice(close + 1).trim() === '';
};

export const isScreened = (body: string): boolean => screenedBy(SCREENED, body);

/** `isScreened`, minus `renderFixLiteral` — the test a `const` binding has to pass. */
export const isShellScreened = (body: string): boolean => screenedBy(SHELL_SCREENED, body);
