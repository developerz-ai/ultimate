// `x errors explain` answers for the codes the gate prints from guards: every shipped guard's code,
// from the guard's own declaration, and an app guard's code from the file in its `guards/`. The
// app's `CLAUDE.md` tells an agent to run it on any code the gate printed; `X_ERROR_CODE_UNKNOWN`
// for `X_RAW_COLOUR` sent it nowhere.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { tempTrees } from '@ultimat3/testing';
import { REQUIRED_BUN } from './app-root';
import { errorsCommand } from './cmd-errors';
import { explainGuardCode } from './cmd-errors-guards';
import type { CommandContext } from './command';
import { exec } from './exec';
import { SHIPPED_GUARD_NAMES, shippedGuardCode } from './guards-shipped-names';
import type { JsonValue } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const trees = tempTrees();
afterAll(() => trees.dispose());

const ctxFor = (argv: readonly string[], cwd = '/tmp'): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value as Record<string, JsonValue>;

describe('unit · x errors explain, guard codes', () => {
  test('X_RAW_COLOUR answers from the raw-colour guard, never X_ERROR_CODE_UNKNOWN', async () => {
    const result = await errorsCommand.run(ctxFor(['errors', 'explain', 'X_RAW_COLOUR']));
    expect(result.ok).toBe(true);
    const data = record(result.data);
    expect(data['code']).toBe('X_RAW_COLOUR');
    expect(String(data['cause'])).toContain('a stylesheet names a semantic token, never a colour');
    expect(String(data['fix'])).toStartWith('x verify --only boundaries --json');
    expect(String(data['fix'])).toContain('"raw-colour": "off"');
    expect(data['docs']).toBe(ERROR_DOCS_URL);
    // The catalog load reads every installed package's source once (`cmd-errors.test.ts`).
  }, 180_000);

  test('every shipped guard code is explained with its own summary', async () => {
    for (const name of SHIPPED_GUARD_NAMES) {
      const explained = await explainGuardCode(shippedGuardCode(name), '/tmp');
      expect(explained?.cause, name).toContain(`the shipped ${name} guard`);
      // The summary was read off the template: the fallback is the bare name.
      expect(explained?.cause, name).not.toContain(`refuses it: ${name} (`);
    }
  });

  test("an app guard's code is explained from guards/<file>.ts", async () => {
    const root = trees.make('x-errors-guard-');
    await Bun.write(
      join(root, 'guards', 'no-lodash.ts'),
      "const CODE = 'X_NO_LODASH';\nexport const guard = {\n  summary: 'no lodash import',\n  check: () => [],\n};\n",
    );
    const result = await errorsCommand.run(ctxFor(['errors', 'explain', 'X_NO_LODASH'], root));
    const data = record(result.data);
    expect(String(data['cause'])).toContain('no lodash import');
    expect(String(data['cause'])).toContain('guards/no-lodash.ts');
    expect(String(data['fix'])).toStartWith('x verify --only boundaries --json');
  }, 180_000);

  test('a code no guard raises is still refused', async () => {
    expect(await explainGuardCode('X_NOT_A_GUARD_EVER', '/tmp')).toBeUndefined();
  });
});
