// The one "stop the holder, run it alone, start again" fix line: what a command that needs the
// embedded database to itself is told beside a live `x dev`. One builder, one quoting rule.

import { quoteArg } from './shell-quote';

/**
 * `x stop --json && x <command> && x dev`. `x stop`, not `kill <pid>`: a kill returns before the
 * drain ends and the next boot refuses. `command` is the refused command's own words, each quoted
 * on its own (`quoteArg`), never spliced; a caller's trailing `# remark` goes after the line.
 */
export const stopRunStartFix = (command: readonly string[]): string =>
  ['x', 'stop', '--json', '&&', 'x', ...command.map(quoteArg), '&&', 'x', 'dev'].join(' ');
