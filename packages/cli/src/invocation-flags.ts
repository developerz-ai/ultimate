// The flags a caller set, spelled so pasting them reproduces the same run. A `fix:` that re-runs a
// command with `--force` and loses `--feature` or `--dir` writes somewhere the caller never asked
// for — `x g`'s conflict fix wrote a second slice, `x new`'s a second app in the cwd.

import type { CommandSpec, ParsedArgs } from './parse';
import { quoteArg } from './shell-quote';

/** Never reproduced: the fix adds its own `--force`, and output flags do not change what runs. */
const NOT_REPRODUCED = new Set(['force', 'dry-run', 'json', 'help', 'verbose', 'cwd']);

/**
 * Every declared flag whose value differs from its default, in the spec's order: a string as
 * `--name <quoted>`, a boolean as `--name` or `--no-name`. A default is nobody's request, so it is
 * left for the default to supply again.
 */
export function reproducedFlags(spec: CommandSpec, args: ParsedArgs): readonly string[] {
  const out: string[] = [];
  for (const flag of spec.flags ?? []) {
    if (NOT_REPRODUCED.has(flag.name)) continue;
    const value = args.flags.get(flag.name);
    if (value === undefined || value === flag.default) continue;
    if (typeof value === 'string') out.push(`--${flag.name}`, quoteArg(value));
    else out.push(value ? `--${flag.name}` : `--no-${flag.name}`);
  }
  return out;
}
