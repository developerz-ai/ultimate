// The one I/O path, driven end to end. Every assertion here is about the PARSE-FAILURE branch,
// because that is the one an agent hits by accident — a typo'd flag, a typo'd command — and it is
// the one branch that has no `ParsedArgs` to read `--json` off.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { currentLogStream, setLogStream } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { dispatch, sinkFor } from './dispatch';
import type { CommandResult } from './output';
import { SPECS } from './registry';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** Records a directory `mkdtemp` made, for the removal above. */
const made = (dir: string): string => {
  madeDirs.push(dir);
  return dir;
};

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
  const outsideAnApp = (): string => made(mkdtempSync(`${tmpdir()}/x-no-app-`));

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

// The parser's refusals keep their own codes: an undeclared flag on a shipped command is a bad flag,
// and a word that is no command stays unknown with or without one.
describe("unit · a refused invocation answers the parser's own code", () => {
  const finding = (out: string): { code?: string; fix?: string } =>
    (JSON.parse(out) as { findings?: { code: string; fix: string }[] }).findings?.[0] ?? {};

  test('a command that left the planned table is unknown, flags or not', async () => {
    // `x branch` was this test's planned example until plan 101b slice 13 emptied the table: it is
    // no longer a command, so a flag on it is the unknown command, never a bad flag.
    const result = await run(['branch', '--follow', '--json']);
    expect(result.code).toBe(1);
    expect(finding(result.out).code).toBe('X_CLI_UNKNOWN_COMMAND');
  });

  test('a shipped command and an unknown word keep their own refusals', async () => {
    expect(finding((await run(['doctor', '--no-such-flag', '--json'])).out).code).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(finding((await run(['nosuchcommand', '--no-such-flag', '--json'])).out).code).toBe(
      'X_CLI_UNKNOWN_COMMAND',
    );
  });

  // A Bun too old is a fact about the environment and outranks everything: it is why the version
  // check and the parse do not share one catch.
  test('an unsupported Bun still wins over a refused parse', async () => {
    const lines: string[] = [];
    const code = await dispatch({
      argv: ['branch', '--follow', '--json'],
      cwd: import.meta.dir,
      env: {},
      bunVersion: '1.0.0',
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(finding(lines.join('\n')).code).toBe('X_BUN_VERSION');
  });
});

/**
 * Two facts about fd 1 that every command depends on and no command can enforce alone: the answer
 * goes there, and NOTHING ELSE does. Both were false — `x mcp serve --transport stdio` printed a
 * `✓ …` banner onto a stream carrying JSON-RPC frames, and every command that boots the app wrote
 * the boot logger's lines onto the stdout a `--json` caller was about to parse.
 */
describe('unit · the dispatcher owns fd 1', () => {
  const answer = (extra: Partial<CommandResult> = {}): CommandResult => ({
    ok: true,
    command: 'mcp',
    summary: 'mcp stdio serving 18 tools',
    ...extra,
  });

  test('a result that declares stderr goes to the error sink, and nothing else does', () => {
    const out: string[] = [];
    const err: string[] = [];
    const options = {
      write: (line: string) => out.push(line),
      writeError: (line: string) => err.push(line),
    };
    sinkFor(answer({ stream: 'stderr' }), options)('banner');
    sinkFor(answer(), options)('{"ok":true}');
    // The default is unchanged and is the one every other command takes.
    sinkFor(answer({ stream: 'stdout' }), options)('also stdout');
    expect(err).toEqual(['banner']);
    expect(out).toEqual(['{"ok":true}', 'also stdout']);
  });

  // An embedding caller that supplies one sink still gets output: the fallback is deliberate, and
  // it is why `writeError` is optional rather than a fifth required field on every call site.
  test('with no error sink the line still lands, on the one sink there is', () => {
    const out: string[] = [];
    sinkFor(answer({ stream: 'stderr' }), { write: (line: string) => out.push(line) })('banner');
    expect(out).toEqual(['banner']);
  });

  test('--json moves the boot logger off stdout while the command runs, for every command', async () => {
    const seen: string[] = [];
    // The sink is written INSIDE the dispatch: what it reads is the stream the command logged to.
    const during = async (argv: readonly string[]): Promise<void> => {
      await dispatch({
        argv,
        cwd: import.meta.dir,
        env: {},
        bunVersion: REQUIRED_BUN,
        write: () => seen.push(currentLogStream()),
      });
    };
    // `x help` boots nothing, which is the point: the decision is the DISPATCHER's and is taken
    // for all thirty commands, not remembered by each one that happens to open a database.
    await during(['help', '--json']);
    await during(['help']);
    expect(seen).toEqual(['stderr', 'stdout']);
  });

  // The stream is process-wide: a `--json` dispatch that left `stderr` behind moved every later
  // log line of the process — the next test FILE's included, on a shared (isolate-off) worker.
  test('a dispatch puts the log stream back the way it found it, both ways', async () => {
    try {
      await run(['help', '--json']);
      expect(currentLogStream()).toBe('stdout');
      setLogStream('stderr');
      await run(['help']);
      expect(currentLogStream()).toBe('stderr');
    } finally {
      setLogStream('stdout');
    }
  });
});
