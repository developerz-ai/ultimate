// `new-error-code --help` / `-h`: the usage of both modes — a package's code and a script's — as
// the answer, exit 0. Before it, `--help` was an unknown flag and answered X_NEW_ERROR_CODE_INVALID,
// so the one question a first-time caller asks was a refusal.

import type { ScriptResult } from './lib/log';

/** Every line the help prints: the package form, the script form, and what each one writes. */
export const NEW_ERROR_CODE_USAGE: readonly string[] = [
  'usage:',
  "  bun run new-error-code X_PKG_WHAT_FAILED --package <pkg> --title '<one line>' --cause '<what usually makes it happen>' --fix '<command or edit>' (--status <n> | --off-socket) [--browser | --server-only] [--section '<## heading>'] [--dry-run] [--json]",
  '      a framework package code: its registration, its wiki/Error-Codes.md row and its HTTP status decision, in one edit.',
  '      --status/--off-socket: exactly one for a tier <= 4 package, neither above it.',
  '      --browser/--server-only: exactly one where the package keeps error-titles-server.ts (realtime), neither elsewhere.',
  "  bun run new-error-code X_SCRIPT_WHAT_FAILED --script scripts/<file>.ts --title '<one line>' --cause '<what usually makes it happen>' --fix '<command or edit>' [--section '<## heading>'] [--dry-run] [--json]",
  "      a code a repo script owns: the wiki/Error-Codes.md never-ships list entry and its row (default section 'CLI and verify'); no package registration, no HTTP status.",
];

/** The flags that take the next word as their value: that word is never a request for help. */
const VALUED = new Set([
  '--package',
  '--title',
  '--cause',
  '--fix',
  '--status',
  '--section',
  '--script',
]);

/** Whether the command line asks for help: `--help` or `-h` as a word of its own, not a flag's value. */
export const wantsHelp = (argv: readonly string[]): boolean =>
  argv.some(
    (word, index) =>
      (word === '--help' || word === '-h' || word.startsWith('--help=')) &&
      !VALUED.has(argv[index - 1] ?? ''),
  );

/** The help, as the one result shape every script reports. */
export const newErrorCodeHelp = (script: string): ScriptResult => ({
  ok: true,
  script,
  summary: 'two modes: --package for a framework package code, --script for a repo script code',
  lines: [...NEW_ERROR_CODE_USAGE],
  data: { usage: NEW_ERROR_CODE_USAGE },
});
