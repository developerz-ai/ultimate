// The factory lint on the `unit` step: no file is silence, a valid set is silence, and a factory or
// trait whose row its entity refuses is `X_TEST_FACTORY_INVALID` naming the factory, the trait and
// the file to edit. One real child run proves the script itself, the rest feed a report.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { exec } from './exec';
import { FACTORIES_FILE, factoryFindings } from './verify-factories';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Inside this package, so the child resolves `@ultimat3/*` from its own `node_modules`. */
const appRoot = async (factories?: string): Promise<string> => {
  const dir = mkdtempSync(join(import.meta.dir, '..', '.factories-fixture-'));
  dirs.push(dir);
  if (factories !== undefined) await Bun.write(join(dir, FACTORIES_FILE), factories);
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

const SET = `import { entity, text, uuid } from '@ultimat3/entity';
import { defineFactory } from '@ultimat3/testing';
const orgs = entity('org', { columns: { id: uuid().primaryKey(), name: text() } });
export const factories = {
  org: defineFactory(orgs, {
    defaults: (n, ids) => ({ id: ids.uuid(), name: \`Org \${n}\` }),
    traits: { BROKEN },
  }),
};
`;

describe('unit · the factory lint', () => {
  test('no factories file: nothing spawned, nothing said', async () => {
    let spawned = false;
    const runner: Runner = async (command) => {
      spawned = true;
      return answering('[]')(command, { cwd: '' });
    };
    expect(await factoryFindings(await appRoot(), runner)).toEqual([]);
    expect(spawned).toBe(false);
  });

  test('a refused trait is coded, and the fix names the factory, the trait and the file', async () => {
    const report = [
      {
        factory: 'org',
        trait: 'nameless',
        strategy: 'build',
        code: 'X_ENTITY_INVALID',
        cause: 'name is required',
      },
    ];
    const [finding, ...rest] = await factoryFindings(
      await appRoot('export const factories = {};\n'),
      answering(`noise\n${JSON.stringify(report)}\n`),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_TEST_FACTORY_INVALID');
    expect(finding?.cause).toContain("org.with('nameless').build()");
    expect(finding?.cause).toContain('X_ENTITY_INVALID');
    expect(finding?.fix).toStartWith('traits: { "nameless": {');
    expect(finding?.fix).toContain('factory "org"');
    expect(finding?.fix).toContain(FACTORIES_FILE);
    expect(finding?.at).toBe(FACTORIES_FILE);
  });

  test('a file that will not load is one finding with the reason, never a pass', async () => {
    const findings = await factoryFindings(
      await appRoot('export const factories = {};\n'),
      answering('', 'SyntaxError: Unexpected token'),
    );
    expect(findings.map((f) => f.code)).toEqual(['X_TEST_FACTORY_INVALID']);
    expect(findings[0]?.cause).toContain('SyntaxError');
  });

  test(
    'a real child: a valid set is green, a trait its entity refuses is red',
    async () => {
      const valid = await appRoot(SET.replace('{ BROKEN }', "{ renamed: { name: 'Renamed' } }"));
      expect(await factoryFindings(valid, exec)).toEqual([]);
      const broken = await appRoot(SET.replace('{ BROKEN }', '{ bogus: { colour: 1 } }'));
      const findings = await factoryFindings(broken, exec);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.fix.startsWith('traits: { "bogus"'))).toBe(true);
    },
    { timeout: 60_000 },
  );
});
