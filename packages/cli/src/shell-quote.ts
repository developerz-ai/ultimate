// POSIX single-quoting for a value the CLI pastes into a line a reader runs — a `fix:`, a
// reproduce command. Its own module, and not `test-shards.ts` where it started, because the
// subprocess boundary needs it too and `test-shards.ts` imports `exec.ts`: one leaf both can
// reach is the alternative to an import cycle or a second quoter.

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/**
 * A program name, a `--filter` or a path holding a space, a `$` or a `;` pastes back as two
 * arguments or as a second command, so an unquoted line runs something other than what it claims.
 * `'\''` is the only escape a single-quoted string has. A shell-safe value is left alone, so the
 * common case stays readable.
 */
const quoteOne = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.split("'").join("'\\''")}'`;

/**
 * A word list is an INVOCATION (`['g', 'route', name]`): each word quoted on its own and joined,
 * because quoting it whole made `x 'g route posts'`, one word no command answers to.
 */
export const quoteArg = (value: string | readonly string[]): string =>
  typeof value === 'string' ? quoteOne(value) : value.map(quoteOne).join(' ');
