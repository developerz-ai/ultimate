// `x errors` is the command an agent reaches for when it has a code and no context, so the two
// things asserted hardest here are that a real code answers with a runnable fix, and that an
// invented one is refused instead of explained.

import { describe, expect, test } from 'bun:test';
import { ERRORS_SUBCOMMANDS, errorsCommand } from './cmd-errors';
import type { CommandContext } from './command';
import { exec } from './exec';
import type { CommandResult, JsonValue } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: '/tmp',
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

const run = (argv: readonly string[]): Promise<CommandResult> => errorsCommand.run(ctxFor(argv));

const record = (value: JsonValue | undefined): Record<string, JsonValue> => {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, JsonValue>;
};

const rejection = async (argv: readonly string[]): Promise<{ readonly fix: string }> => {
  const caught: unknown = await run(argv).then(
    () => undefined,
    (error: unknown) => error,
  );
  return caught as { readonly fix: string };
};

describe('unit · x errors explain', () => {
  // `X_DB_DRIFT` and not `X_CONFIG_INVALID`: the exemplar has to be a code the CLI neither owns
  // nor borrows, or the test stops asserting the fallback it is named for. `X_CONFIG_INVALID`
  // became a borrowed code when `x env` shipped (`CLI_BORROWED_ERROR_CODES`), so it now answers
  // with the CLI's own fix — which is the case the next test covers.
  test('a code the CLI neither owns nor borrows falls back to the gate', async () => {
    const result = await run(['errors', 'explain', 'X_DB_DRIFT']);
    expect(result.ok).toBe(true);
    expect(record(result.data)).toEqual({
      code: 'X_DB_DRIFT',
      cause: 'schema differs from migrations',
      fix: 'x verify --json',
      docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
    });
    expect(result.lines).toEqual([
      '  cause: schema differs from migrations',
      '  fix:   x verify --json',
      '  docs:  https://ultimate.dev/errors/X_DB_DRIFT',
    ]);
  });

  test("a CLI code answers with the CLI's own fix, not the generic gate", async () => {
    const result = await run(['errors', 'explain', 'X_BUN_VERSION']);
    expect(record(result.data)['fix']).toBe('bun upgrade');
  });

  test('a code added by this task is registered, not humanised', async () => {
    const result = await run(['errors', 'explain', 'X_JOB_UNKNOWN']);
    expect(record(result.data)['cause']).toBe('the queue holds no job with this id');
    expect(record(result.data)['fix']).toBe('x jobs ls --json');
  });

  test('an unregistered code is refused, never explained', async () => {
    await expect(run(['errors', 'explain', 'X_TOTALLY_MADE_UP_THING'])).rejects.toBeUltimateError(
      'X_ERROR_CODE_UNKNOWN',
    );
  });

  test('a near miss suggests the real code as the fix', async () => {
    const failure = await rejection(['errors', 'explain', 'X_BUN_VERSIO']);
    expect(failure).toBeUltimateError('X_ERROR_CODE_UNKNOWN');
    expect(failure.fix).toBe('x errors explain X_BUN_VERSION');
  });

  test('explain with no code is a flag error pointing at the list', async () => {
    const failure = await rejection(['errors', 'explain']);
    expect(failure).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x errors list --json');
  });
});

describe('unit · x errors list', () => {
  const listed = async (): Promise<readonly Record<string, JsonValue>[]> => {
    const result = await run(['errors', 'list']);
    const entries = record(result.data)['codes'];
    expect(Array.isArray(entries)).toBe(true);
    return (entries as readonly JsonValue[]).map(record);
  };

  test('enumerates every registered code, sorted, with one line each', async () => {
    const result = await run(['errors', 'list']);
    const codes = (await listed()).map((entry) => entry['code']);
    expect(codes.length).toBeGreaterThan(150);
    expect([...codes]).toEqual([...codes].sort());
    expect(result.lines).toHaveLength(codes.length);
  });

  test("includes the CLI's own codes — errors.ts registers their titles at import", async () => {
    const codes = (await listed()).map((entry) => entry['code']);
    expect(codes).toContain('X_VERIFY_FAILED');
    expect(codes).toContain('X_DECLARATION_UNKNOWN');
  });

  test('includes codes from packages no `x` command imports — the catalog loads them', async () => {
    const codes = (await listed()).map((entry) => entry['code']);
    expect(codes).toContain('X_UNAUTHENTICATED');
    expect(codes).toContain('X_VALIDATION_FAILED');
    expect(codes).toContain('X_PWA_ICON_MISSING');
  });

  test('every listed code carries a non-empty fix — that is the whole contract', async () => {
    for (const entry of await listed()) {
      expect(String(entry['fix']).length).toBeGreaterThan(0);
    }
  });

  test('names the packages it could not import instead of hiding the gap', async () => {
    const result = await run(['errors', 'list']);
    expect(Array.isArray(record(result.data)['unavailable'])).toBe(true);
  });
});

describe('unit · the spec', () => {
  test('explain is the default subcommand, so `x errors X_FOO` is a usage error not a guess', () => {
    expect(ERRORS_SUBCOMMANDS[0]).toBe('explain');
    expect(errorsCommand.spec.subcommands).toEqual(ERRORS_SUBCOMMANDS);
  });

  test('runs outside an app — triaging a code must not require an app root', () => {
    expect(errorsCommand.spec.requiresApp).toBeUndefined();
  });
});

describe('unit · a missing CODE names the positional, never an invented flag', () => {
  // `x errors --json` reported `--code on "x errors"`. There is no `--code` flag, so an agent
  // reading the cause literally ran `x errors --code X_DB_DRIFT` and got a SECOND X_CLI_BAD_FLAG.
  test('the cause says positional and names no flag that does not exist', async () => {
    const failure = (await rejection(['errors', '--json'])) as unknown as {
      code: string;
      cause: string;
      fix: string;
    };
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('positional');
    expect(failure.cause).not.toContain('--code');
    // Runnable verbatim, and it is the command that lists the codes to pick from.
    expect(failure.fix).toBe('x errors list --json');
  });
});
