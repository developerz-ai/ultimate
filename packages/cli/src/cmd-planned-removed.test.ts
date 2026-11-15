// The planned subcommands that left the registry (plan 101-finished-and-self-maintained G6): each is
// gone from its command's list and from `PLANNED_SUBCOMMANDS`, is refused by the parser with the
// same exit code a planned one had, and has its reason in `wiki/Known-Gaps.md` — never silence.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { PLANNED_SUBCOMMANDS } from './cmd-planned';
import { dispatch } from './dispatch';
import { commandFor } from './registry';

const REMOVED = [
  ['token', 'grant'],
  ['cache', 'stats'],
  ['db', 'studio'],
  ['jobs', 'drain'],
] as const;

const KNOWN_GAPS = join(import.meta.dir, '..', '..', '..', 'wiki', 'Known-Gaps.md');

async function run(argv: readonly string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await dispatch({
    argv,
    cwd: import.meta.dir,
    env: {},
    bunVersion: REQUIRED_BUN,
    write: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
}

describe('unit · planned subcommands that left the registry', () => {
  test.each(REMOVED)('x %s %s is not declared, and not planned', (command, subcommand) => {
    expect(commandFor(command)?.spec.subcommands ?? []).not.toContain(subcommand);
    expect(
      PLANNED_SUBCOMMANDS.some(
        (entry) => entry.command === command && entry.subcommand === subcommand,
      ),
    ).toBe(false);
  });

  // Exit 1 before and after: X_NOT_IMPLEMENTED and X_CLI_UNKNOWN_COMMAND are both failures, so a
  // script that ran one of these sees the same exit code; only the code inside `--json` moved.
  test.each(REMOVED)('x %s %s exits 1, refused by the parser', async (command, subcommand) => {
    const { code, out } = await run([command, subcommand, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { findings: { code: string; cause: string }[] };
    expect(parsed.findings[0]?.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(parsed.findings[0]?.cause).toContain(`x ${command} ${subcommand}`);
  });

  test.each(REMOVED)(
    'x %s %s has its reason in wiki/Known-Gaps.md',
    async (command, subcommand) => {
      const gaps = await Bun.file(KNOWN_GAPS).text();
      expect(gaps).toContain(`| \`x ${command}\`'s \`${subcommand}\` | removed from the registry`);
    },
  );
});
