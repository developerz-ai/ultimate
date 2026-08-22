// The one I/O path, driven end to end. Every assertion here is about the PARSE-FAILURE branch,
// because that is the one an agent hits by accident — a typo'd flag, a typo'd command — and it is
// the one branch that has no `ParsedArgs` to read `--json` off.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// `node:process`, and unavoidable: the assertion below is about which of the process's OWN streams
// core's default log writer reaches, so the writers it targets are what this test has to intercept.
import process from 'node:process';
import { logger, setLogStream } from '@ultimat3/core';
import { PLANNED_COMMANDS } from './cmd-planned';
import { dispatch, sinkFor } from './dispatch';
import type { CommandResult } from './output';
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

// A planned command is not built, and every invocation of one must say so. The unknown-flag
// refusal fires in the parser, BEFORE any `run`, so `x logs tail --follow` answered
// `X_CLI_BAD_FLAG` naming "known: json, help, cwd, verbose" — a flag list for a command that does
// not exist yet — while `x logs tail` answered the honest X_NOT_IMPLEMENTED with a runnable fix.
// One invocation apart, two different stories, and the wrong one sends an agent hunting a typo.
describe('unit · a planned command answers X_NOT_IMPLEMENTED however it is invoked', () => {
  const finding = (out: string): { code?: string; fix?: string } =>
    (JSON.parse(out) as { findings?: { code: string; fix: string }[] }).findings?.[0] ?? {};

  test('a flag the planned command never declared is still not-implemented', async () => {
    const result = await run(['logs', 'tail', '--follow', '--json']);
    expect(result.code).toBe(1);
    // The same fix the command's own `run` would have thrown — one answer for one command.
    expect(finding(result.out)).toMatchObject({
      code: 'X_NOT_IMPLEMENTED',
      fix: 'x dev   # then the timeline panel at /_x',
    });
  });

  test('every planned command answers it, with its own fix, for a flag it never declared', async () => {
    for (const planned of PLANNED_COMMANDS) {
      const result = await run([planned.name, '--no-such-flag', '--json']);
      expect([planned.name, finding(result.out).code]).toEqual([planned.name, 'X_NOT_IMPLEMENTED']);
      expect([planned.name, finding(result.out).fix]).toEqual([planned.name, planned.fix]);
    }
  });

  // The pre-empt is scoped to planned commands: a shipped command's bad flag is still a bad flag,
  // and a command nobody ships is still unknown.
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
  test('an unsupported Bun still wins over the planned pre-empt', async () => {
    const lines: string[] = [];
    const code = await dispatch({
      argv: ['logs', 'tail', '--follow', '--json'],
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
    summary: 'mcp stdio serving 13 tools',
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

  test('--json moves the boot logger off stdout, for every command', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const probe = (): void => {
      process.stdout.write = (chunk: unknown): boolean => {
        out.push(String(chunk));
        return true;
      };
      process.stderr.write = (chunk: unknown): boolean => {
        err.push(String(chunk));
        return true;
      };
      try {
        logger.info('ultimate migrate applied');
      } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
      }
    };
    try {
      // `x help` boots nothing, which is the point: the decision is the DISPATCHER's and is taken
      // for all thirty commands, not remembered by each one that happens to open a database.
      await run(['help', '--json']);
      probe();
      expect(out).toEqual([]);
      expect(err.join('')).toContain('ultimate migrate applied');

      // No `setLogStream('stdout')` here, deliberately: the dispatcher RESETS the stream on every
      // run, and this call standing in for it is what hid a JSON dispatch leaving stderr behind
      // for the next non-JSON one.
      await run(['help']);
      probe();
      expect(out.join('')).toContain('ultimate migrate applied');
    } finally {
      setLogStream('stdout');
    }
  });
});
