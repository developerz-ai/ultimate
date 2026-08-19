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
export const quoteArg = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.split("'").join("'\\''")}'`;
