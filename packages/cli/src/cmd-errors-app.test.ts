// `x errors explain <CODE>` for a code the APP declares (`defineError` in a slice's `errors.ts`, as
// `x g resource` writes it): answered from the loaded app's declaration, inside the app only. The
// scaffold's CLAUDE.md sends every printed code here, and an app code answered X_ERROR_CODE_UNKNOWN.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; the app root is a real directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { errorsCommand } from './cmd-errors';
import type { CommandContext } from './command';
import { exec } from './exec';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ERRORS = 'apps/web/app/ticket/errors.ts';

/** An app whose ticket slice declares its not-found code the way `x g resource` writes it. */
async function app(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-errors-app-'));
  dirs.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(
    join(dir, ERRORS),
    `import { defineError } from ${JSON.stringify(import.meta.resolve('@ultimat3/core/page'))};

export const TicketNotFoundError = defineError<{ readonly id: string }>({
  code: 'X_TICKET_NOT_FOUND',
  title: 'no such ticket',
  status: 404,
  cause: (input) => \`no ticket with id \${input.id}\`,
  fix: 'x queries list --json, then pass an id the ticket read returns',
});
`,
  );
  return dir;
}

const run = (argv: readonly string[], cwd: string): Promise<CommandResult> => {
  const ctx: CommandContext = {
    args: parseArgs(argv, SPECS),
    cwd,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  };
  return errorsCommand.run(ctx);
};

const rejected = async (call: Promise<unknown>): Promise<{ code: string; fix: string }> =>
  (await call.then(
    () => expect.unreachable('expected X_ERROR_CODE_UNKNOWN'),
    (error: unknown) => error,
  )) as { code: string; fix: string };

describe('unit · x errors explain answers the app’s own codes', () => {
  test('inside the app: title, cause, fix, status and where it is declared', async () => {
    const result = await run(['errors', 'explain', 'X_TICKET_NOT_FOUND', '--json'], await app());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      code: 'X_TICKET_NOT_FOUND',
      title: 'no such ticket',
      status: 404,
      fix: 'x queries list --json, then pass an id the ticket read returns',
      site: { at: ERRORS, line: 4 },
    });
    expect(String((result.data as { cause: string }).cause)).toContain('no ticket with id');
    expect(result.lines?.join('\n')).toContain('x queries list --json');
  }, 30_000);

  test('a code the app does not declare is still unknown, and the fix says where codes live', async () => {
    const failure = await rejected(run(['errors', 'explain', 'X_ZZZZ_NOPE_QQQQ'], await app()));
    expect(failure.code).toBe('X_ERROR_CODE_UNKNOWN');
    expect(failure.fix).toContain('defineError');
  }, 30_000);

  test('outside an app an app code is unknown, and the fix says to run it in the app', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'x-errors-noapp-'));
    dirs.push(outside);
    // A code no module in this process declared: the case above registered X_TICKET_NOT_FOUND, and
    // core's registry is the process's, as it is in one `x` invocation.
    const failure = await rejected(run(['errors', 'explain', 'X_RECEIPT_NOT_FOUND'], outside));
    expect(failure.code).toBe('X_ERROR_CODE_UNKNOWN');
    expect(failure.fix).toContain('--cwd');
  });
});
