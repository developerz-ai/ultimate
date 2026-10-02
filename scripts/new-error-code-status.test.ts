// The third edit `new-error-code` makes: the code's HTTP status, decided in the same run as its
// registration and its wiki row. Split from `new-error-code.test.ts` at the 500-line ceiling.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdir of its own.
import { mkdir } from 'node:fs/promises';
import { HTTP_STATUS_MAX_TIER } from './error-map';
import { backlogPinIn, statusRowIn } from './lib/error-code-plan';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { ScriptError } from './lib/script-error';
import {
  newErrorCode,
  STATUS_BACKLOG,
  STATUS_TABLE,
  STATUS_TABLE_MAX_TIER,
  WIKI_PAGE,
} from './new-error-code';
import {
  fixtureRoot,
  read,
  refusal,
  removeFixtureRoots,
  transpiles,
} from './new-error-code.fixtures';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

describe('the HTTP status is decided in the same edit', () => {
  // Three workers registered a code, got a green script, and met `X_ERROR_STATUS_MISSING` on the
  // gate's `errors` step: nothing had decided whether the code answers a request (plan 101).
  const money = (code: string, ...rest: string[]) => [
    code,
    '--package',
    'money',
    '--title',
    'a title',
    '--cause',
    'what usually makes it happen',
    '--fix',
    'x doctor --json',
    ...rest,
  ];

  test('--status writes the row in the status table, inside the literal', async () => {
    const dir = await fixtureRoot();
    const result = await newErrorCode(dir, money('X_MONEY_PROBE_ONLY', '--status', '422'));
    expect(result.written).toEqual(['packages/money/src/errors.ts', WIKI_PAGE, STATUS_TABLE]);
    const table = await read(dir, STATUS_TABLE);
    expect(table).toContain('  // @ultimat3/money — a title\n  X_MONEY_PROBE_ONLY: 422,\n');
    // Inside the literal: nothing after its close names the code.
    expect(table.slice(table.lastIndexOf('} satisfies'))).not.toContain('X_MONEY_PROBE_ONLY');
    expect(transpiles(table)).toBe(true);
    expect(await read(dir, STATUS_BACKLOG)).not.toContain('X_MONEY_PROBE_ONLY');
  });

  test('--off-socket pins it in the backlog, in its package`s group', async () => {
    const dir = await fixtureRoot();
    const result = await newErrorCode(dir, money('X_MONEY_PROBE_ONLY', '--off-socket'));
    expect(result.written).toEqual(['packages/money/src/errors.ts', WIKI_PAGE, STATUS_BACKLOG]);
    const backlog = await read(dir, STATUS_BACKLOG);
    // In money's own group: between its opening line and the first `],` after it.
    const [, after = ''] = backlog.split('\n  money: [');
    const [group = ''] = after.split('\n  ],');
    expect(group).toContain("'X_MONEY_PROBE_ONLY',");
    expect(transpiles(backlog)).toBe(true);
    expect(await read(dir, STATUS_TABLE)).not.toContain('X_MONEY_PROBE_ONLY');
  });

  test('a one-line group and a package with no group yet both take the pin', async () => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/policy/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/policy/src/errors.ts`,
      "export const POLICY_TITLES = {\n  X_A: 'a',\n};\n",
    );
    await newErrorCode(dir, [
      'X_POLICY_PROBE_ONLY',
      '--package',
      'policy',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'f',
      '--off-socket',
    ]);
    const backlog = await read(dir, STATUS_BACKLOG);
    expect(backlog).toContain("  policy: ['X_ROLE_REDEFINED', 'X_POLICY_PROBE_ONLY'],");
    // `http` owns the table and pins nothing: a group is created for it, before the close.
    await mkdir(`${dir}/packages/http/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/http/src/errors.ts`,
      "export const HTTP_TITLES = {\n  X_A: 'a',\n};\n",
    );
    await newErrorCode(dir, [
      'X_HTTP_PROBE_ONLY',
      '--package',
      'http',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'f',
      '--off-socket',
    ]);
    const after = await read(dir, STATUS_BACKLOG);
    expect(after).toContain("  http: ['X_HTTP_PROBE_ONLY'],\n};");
    expect(transpiles(after)).toBe(true);
  });

  test('neither flag, or both, is refused naming both — and nothing is written', async () => {
    const dir = await fixtureRoot();
    const before = [
      await read(dir, 'packages/money/src/errors.ts'),
      await read(dir, WIKI_PAGE),
      await read(dir, STATUS_TABLE),
      await read(dir, STATUS_BACKLOG),
    ];
    for (const rest of [[], ['--status', '422', '--off-socket']]) {
      const error = await newErrorCode(dir, money('X_MONEY_PROBE_ONLY', ...rest)).then(
        () => expect.unreachable('the generator wrote with no status decided'),
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof ScriptError)) return expect.unreachable('not a ScriptError');
      expect(error.code).toBe('X_NEW_ERROR_CODE_INVALID');
      expect(error.fix).toContain('--status <n>');
      expect(error.fix).toContain('--off-socket');
    }
    expect(
      await refusal(newErrorCode(dir, money('X_MONEY_PROBE_ONLY', '--status', 'teapot'))),
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, money('X_MONEY_PROBE_ONLY', '--status', '99')))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect([
      await read(dir, 'packages/money/src/errors.ts'),
      await read(dir, WIKI_PAGE),
      await read(dir, STATUS_TABLE),
      await read(dir, STATUS_BACKLOG),
    ]).toEqual(before);
  });

  test('a tier-5 package is outside the table: no flag is asked for, and one is refused', async () => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/cli/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/cli/src/error-codes.ts`,
      "export const CLI_TITLES = {\n  X_A: 'a',\n};\n",
    );
    const argv = [
      'X_CLI_PROBE_ONLY',
      '--package',
      'cli',
      '--title',
      't',
      '--cause',
      'what makes it happen',
      '--fix',
      'f',
    ];
    // The CLI types one fix per code, so its fix table is part of the edit and has to be there.
    expect(await refusal(newErrorCode(dir, argv))).toBe('X_NEW_ERROR_CODE_INVALID');
    const fixes = 'packages/cli/src/mcp-errors.ts';
    await Bun.write(`${dir}/${fixes}`, "const CLI_FIXES = {\n  X_A: 'x help --json',\n};\n");
    expect(await refusal(newErrorCode(dir, [...argv, '--status', '500']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    const result = await newErrorCode(dir, argv);
    expect(result.written).toEqual(['packages/cli/src/error-codes.ts', WIKI_PAGE, fixes]);
  });

  test('a code the table or the backlog already names, and a file with no literal, are refused', () => {
    const input = { code: 'X_A_B', pkg: 'money', title: 't', cause: 'c', fix: 'f' };
    const codeOf = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return error instanceof ScriptError ? error.code : 'not a ScriptError';
      }
      return 'planned';
    };
    const table =
      'export const ERROR_STATUS = {\n  X_A_B: 400,\n} satisfies Readonly<Record<string, number>>;\n';
    expect(codeOf(() => statusRowIn(table, 'error-map.ts', input, 400))).toBe(
      'X_NEW_ERROR_CODE_EXISTS',
    );
    expect(codeOf(() => statusRowIn('export const x = 1;\n', 'error-map.ts', input, 400))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    // With no trailing note, the row lands directly before the close.
    expect(statusRowIn(table, 'error-map.ts', { ...input, code: 'X_C_D' }, 409)).toContain(
      '  X_A_B: 400,\n  // @ultimat3/money — t\n  X_C_D: 409,\n} satisfies',
    );
    expect(
      codeOf(() => backlogPinIn("export const B = {\n  money: ['X_A_B'],\n};\n", 'b.ts', input)),
    ).toBe('X_NEW_ERROR_CODE_EXISTS');
    expect(codeOf(() => backlogPinIn('export const B = 1;\n', 'b.ts', input))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
  });

  test('the tier bound is the status guard`s own, restated only so the generator loads mid-edit', () => {
    expect(STATUS_TABLE_MAX_TIER).toBe(HTTP_STATUS_MAX_TIER);
  });
});
