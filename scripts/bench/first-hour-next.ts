// The commands `x g … --json` tells its author to run next (`data.next`, `nextSteps()` in
// `packages/cli/src/cmd-generate.ts`), as argv the bench can run without a shell. Read off the
// generator's own verdict rather than restated here: the first hour skipped `x db gen` while the
// generator printed it, and every gate after the feature went red on a table that did not exist.

/** Either the argv of every next command, in order, or why the verdict could not be read. */
export type NextCommands =
  | { readonly ok: true; readonly commands: readonly (readonly string[])[] }
  | { readonly ok: false; readonly reason: string };

/**
 * One printed command as argv: whitespace splits, a double-quoted run is one word (`x db gen
 * "create notes"`). `bunx` is `bun x` — the same binary — spelled so the bench's clean
 * `BUN_INSTALL` needs nothing on PATH but `bun`.
 */
export function argvOf(line: string): readonly string[] {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words[0] === 'bunx' ? ['bun', 'x', ...words.slice(1)] : words;
}

/**
 * `data.next` off `x g … --json`'s stdout. No `next` is zero commands — a generator that declares
 * no table owes none; stdout that is not the verdict is a failure, because the bench could not
 * know what the author was told.
 */
export function nextCommands(stdout: string): NextCommands {
  let verdict: unknown;
  try {
    verdict = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'x g --json printed no JSON verdict on stdout' };
  }
  const next = (verdict as { data?: { next?: unknown } } | null)?.data?.next;
  if (next === undefined) return { ok: true, commands: [] };
  if (!Array.isArray(next) || !next.every((line) => typeof line === 'string'))
    return { ok: false, reason: 'x g --json data.next is not a list of commands' };
  return { ok: true, commands: next.map(argvOf) };
}

/**
 * `nextCommands` over output that merged stderr after the verdict (`scripts/lib/run.ts`): the
 * last line that parses as a CLI verdict — an object with a boolean `ok` and a `command` — is
 * the one read. No such line is the same failure as unreadable stdout.
 */
export function nextCommandsIn(output: string): NextCommands {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const shape = parsed as { ok?: unknown; command?: unknown } | null;
    if (typeof shape?.ok === 'boolean' && typeof shape.command === 'string')
      return nextCommands(line);
  }
  return nextCommands('');
}
