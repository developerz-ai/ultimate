// The one I/O path, driven end to end. Every assertion here is about the PARSE-FAILURE branch,
// because that is the one an agent hits by accident — a typo'd flag, a typo'd command — and it is
// the one branch that has no `ParsedArgs` to read `--json` off.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dispatch } from './dispatch';
import { SPECS } from './registry';

const REQUIRED_BUN = '1.3.14';

async function run(
  argv: readonly string[],
  cwd: string = import.meta.dir,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await dispatch({
    argv,
    cwd,
    env: {},
    bunVersion: REQUIRED_BUN,
    write: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
}

const parsed = (out: string): { ok: boolean; findings?: { code: string }[] } =>
  JSON.parse(out) as { ok: boolean; findings?: { code: string }[] };

// `CommandSpec.requiresApp` said "the dispatcher enforces it" and `dispatch` never read the field:
// the promise held only because all 17 declaring commands happen to call `requireAppRoot`
// themselves. A new command that declares it and forgets the call ran outside an app with no
// refusal at all, which is the one thing a declaration exists to make impossible.
describe('unit · the dispatcher is what enforces requiresApp', () => {
  /** No `app.config.ts` at or above it — `/tmp/x-no-app-*` walks up to `/`. */
  const outsideAnApp = (): string => mkdtempSync(`${tmpdir()}/x-no-app-`);

  // `x secrets set` is the proof BECAUSE it checks its own positional before it resolves a root:
  // outside an app it answered X_CLI_BAD_FLAG — "you left out the name" — about an invocation that
  // could not have worked in this directory whatever name was given.
  test('the app root is decided before a command reads its own arguments', async () => {
    const result = await run(['secrets', 'set', '--json'], outsideAnApp());
    expect(result.code).toBe(1);
    expect(parsed(result.out).findings?.[0]?.code).toBe('X_NOT_IN_APP');
  });

  test('every command that declares requiresApp is refused there', async () => {
    const declaring = SPECS.filter((spec) => spec.requiresApp === true);
    expect(declaring.length).toBeGreaterThan(0);
    for (const spec of declaring) {
      // A subcommand where the bare form is a PARSE failure (`x db` and `x mcp` declare no
      // default): that refusal is the parser's, and it lands before a command is resolved at all.
      const word =
        spec.subcommands === undefined
          ? undefined
          : (spec.defaultSubcommand ?? spec.subcommands[0]);
      const argv = word === undefined ? [spec.name] : [spec.name, word];
      const result = await run([...argv, '--json'], outsideAnApp());
      expect([argv.join(' '), parsed(result.out).findings?.[0]?.code]).toEqual([
        argv.join(' '),
        'X_NOT_IN_APP',
      ]);
    }
  });

  // The exemption, pinned: usage has to be readable from anywhere, and `--help` swaps the target
  // for the help command — which declares nothing — so this must keep answering outside an app.
  test('--help on a requiresApp command still answers outside an app', async () => {
    const result = await run(['secrets', '--help', '--json'], outsideAnApp());
    expect(result.code).toBe(0);
    expect(parsed(result.out).ok).toBe(true);
  });
});

describe('unit · -j is --json on the parse-failure path too', () => {
  // `options.argv.includes('--json')` missed the short form, so `x doctor -j --bogusflag` rendered
  // its X_CLI_BAD_FLAG as PROSE to a caller that then ran `JSON.parse` on it and threw.
  test('a typo’d flag with -j renders JSON', async () => {
    const short = await run(['doctor', '-j', '--bogusflag']);
    expect(short.code).toBe(1);
    expect(parsed(short.out).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    // The long form always worked; the two must not disagree.
    const long = await run(['doctor', '--json', '--bogusflag']);
    expect(long.out).toBe(short.out.replace('-j', '--json'));
  });

  test('a typo’d COMMAND with -j renders JSON', async () => {
    const result = await run(['nonexistentcmd', '-j']);
    expect(result.code).toBe(1);
    expect(parsed(result.out).findings?.[0]?.code).toBe('X_CLI_UNKNOWN_COMMAND');
  });

  test('without either spelling the same failure is human text', async () => {
    const result = await run(['doctor', '--bogusflag']);
    expect(result.code).toBe(1);
    expect(() => JSON.parse(result.out)).toThrow();
    expect(result.out).toContain('X_CLI_BAD_FLAG');
  });
});
