// The seed run on the `unit` step: no seed file is silence, a seed that writes is silence, and a
// seed whose row its entity refuses surfaces the ENTITY's own code and fix at the top level — the
// `{ minor: 19.99 }` that typechecks and was once found only by `e2e`, inside X_E2E_APP_FAILED.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { exec } from './exec';
import { seedFindings } from './verify-seeds';

const SEED_FILE = 'packages/db/seeds/dev.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Inside this package, so the child resolves `@ultimat3/*` from its own `node_modules`. */
const appRoot = async (seed?: string): Promise<string> => {
  const dir = mkdtempSync(join(import.meta.dir, '..', '.seeds-fixture-'));
  dirs.push(dir);
  if (seed !== undefined) await Bun.write(join(dir, SEED_FILE), seed);
  return dir;
};

const answering =
  (stdout: string, stderr = ''): Runner =>
  async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout,
    stderr,
    durationMs: 1,
  });

const SEED = `import { defineSeed, entity, integer, money, text, uuid } from '@ultimat3/entity';
const plans = entity('plan', {
  columns: { id: uuid().primaryKey(), code: text(), seats: integer(), monthly: money() },
});
export const dev = defineSeed('dev', async ({ insert, id }) => {
  await insert(plans, [{ id: id('plan:team'), code: 'team', seats: 5, monthly: { minor: MINOR, currency: 'USD' } }]);
});
`;

describe('unit · the seed run', () => {
  test('no seed file: nothing spawned, nothing said', async () => {
    let spawned = false;
    const runner: Runner = async (command) => {
      spawned = true;
      return answering('[]')(command, { cwd: '' });
    };
    expect(await seedFindings(await appRoot(), runner)).toEqual([]);
    expect(spawned).toBe(false);
  });

  test("a coded refusal surfaces with the inner error's own code and fix", async () => {
    const report = [
      {
        file: SEED_FILE,
        export: 'dev',
        seed: 'dev',
        code: 'X_INVARIANT_VIOLATED',
        cause: 'got the float 19.99',
        fix: '{ minor: Math.round(amount * 100) }',
        message: 'X_INVARIANT_VIOLATED',
      },
    ];
    const [finding, ...rest] = await seedFindings(
      await appRoot('export {};\n'),
      answering(`noise\n${JSON.stringify(report)}\n`),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_INVARIANT_VIOLATED');
    expect(finding?.cause).toContain('seed "dev"');
    expect(finding?.cause).toContain('got the float 19.99');
    expect(finding?.fix).toBe('{ minor: Math.round(amount * 100) }');
    expect(finding?.at).toBe(SEED_FILE);
  });

  test('an uncoded throw is still a finding, with a command that reproduces it', async () => {
    const report = [
      {
        file: SEED_FILE,
        export: 'dev',
        seed: 'dev',
        code: null,
        cause: null,
        fix: null,
        message: 'boom',
      },
    ];
    const [finding] = await seedFindings(
      await appRoot('export {};\n'),
      answering(JSON.stringify(report)),
    );
    expect(finding?.code).toBe('X_SEED_FAILED');
    expect(finding?.cause).toContain('boom');
    expect(finding?.fix).toContain(SEED_FILE);
    expect(finding?.fix).toContain('.run()');
  });

  test('a child that prints no report is one finding with the reason, never a pass', async () => {
    const findings = await seedFindings(
      await appRoot('export {};\n'),
      answering('', 'SyntaxError: Unexpected token'),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.cause).toContain('SyntaxError');
  });

  test(
    'a real child: integer money is green, a planted float is X_INVARIANT_VIOLATED',
    async () => {
      expect(await seedFindings(await appRoot(SEED.replace('MINOR', '1999')), exec)).toEqual([]);
      const findings = await seedFindings(await appRoot(SEED.replace('MINOR', '19.99')), exec);
      expect(findings.map((f) => f.code)).toEqual(['X_INVARIANT_VIOLATED']);
      expect(findings[0]?.cause).toContain('19.99');
      expect(findings[0]?.fix).toContain('Math.round');
      expect(findings[0]?.at).toBe(SEED_FILE);
      const throwing = SEED.replace('await insert(', "throw new TypeError('boom'); await insert(");
      const [uncoded] = await seedFindings(await appRoot(throwing.replace('MINOR', '1')), exec);
      expect(uncoded?.code).toBe('X_SEED_FAILED');
      expect(uncoded?.cause).toContain('boom');
      expect(uncoded?.fix).toStartWith('bun --eval ');
    },
    { timeout: 60_000 },
  );
});
