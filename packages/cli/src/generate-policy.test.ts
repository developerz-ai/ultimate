// `x g policy <name> --feature <slice>` on a slice that already has its `policy.ts`. It answered
// X_GENERATE_CONFLICT whose fix was the wrong kind (`x g action`) or `--force`, which overwrote the
// slice's rules. A second permission set is APPENDED; the module still loads with both; a real
// collision prints a fix that runs and overwrites nothing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generate, generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { ROLES_FILE } from './permission-grants';
import { SPECS } from './registry';
import { rolesFiles } from './templates/scaffold-roles';

const dirs: string[] = [];
let root = '';
const policyPath = 'apps/web/app/invoice/policy.ts';

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const run = (argv: readonly string[]) => generateCommand.run(contextFor(argv));

/** Inside this package, so a child process resolves `@ultimat3/*` from its `node_modules`. */
beforeEach(async () => {
  root = mkdtempSync(join(import.meta.dir, '..', '.policy-append-fixture-'));
  dirs.push(root);
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
  // The scaffold's role map, so a run's grants land somewhere and the run can be `ok`.
  for (const file of [...rolesFiles(), ...generate({ kind: 'policy', name: 'invoice' })]) {
    if (typeof file.contents === 'string') await Bun.write(join(root, file.path), file.contents);
  }
});

/** The rules the merged module exports, loaded in a child: `definePermissions` is process-global. */
const loaded = async (): Promise<Record<string, readonly string[]>> => {
  const probe = `const m = await import(${JSON.stringify(join(root, policyPath))});
const out = {};
for (const [k, v] of Object.entries(m)) if (k.startsWith('can')) out[k] = v.permissions;
console.log(JSON.stringify(out));`;
  const child = Bun.spawnSync(['bun', '-e', probe], { cwd: root, stderr: 'pipe', timeout: 30_000 });
  if (child.exitCode !== 0) return expect.unreachable(child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as Record<string, readonly string[]>;
};

describe('unit · a second policy in an existing slice', () => {
  test('appends its permission set; the first one still loads beside it', async () => {
    const before = await Bun.file(join(root, policyPath)).text();
    const result = await run(['g', 'policy', 'approval', '--feature', 'invoice']);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    const after = await Bun.file(join(root, policyPath)).text();
    // Every byte the author had is still there, in order: an append, not a rewrite.
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain("'approval:write': true;");
    // One import of each binding: the second set reuses the first's.
    expect(after.match(/from '@ultimat3\/policy'/g)?.length).toBe(1);
    expect(await loaded()).toEqual({
      canInvoiceRead: ['invoice:read'],
      canInvoiceWrite: ['invoice:write'],
      canInvoiceCreate: ['invoice:write'],
      canApprovalRead: ['approval:read'],
      canApprovalWrite: ['approval:write'],
      canApprovalCreate: ['approval:write'],
    });
    // Its own test, beside the slice's — never over it.
    expect(
      await Bun.file(join(root, 'apps/web/app/invoice/policy-approval.test.ts')).exists(),
    ).toBe(true);
  });

  test('the same set again is a conflict whose fix runs and overwrites nothing', async () => {
    const before = await Bun.file(join(root, policyPath)).text();
    const result = await run(['g', 'policy', 'invoice', '--feature', 'invoice']);
    const fixes = (result.findings ?? [])
      .filter((one) => one.code === 'X_GENERATE_CONFLICT' && one.at === policyPath)
      .map((one) => one.fix ?? '');
    expect(fixes.length).toBe(1);
    const [fix = ''] = fixes;
    expect(fix).not.toContain('--force');
    expect(fix).not.toMatch(/^x g (action|query|mutator)/);
    expect(fix.split('#')[0]).not.toMatch(/<[a-z]/i);
    expect(await Bun.file(join(root, policyPath)).text()).toBe(before);
    // The line it names appends, which is what the author was after.
    const argv = (fix.split('#')[0] ?? '').trim().split(/\s+/).slice(1);
    expect(argv.slice(0, 2)).toEqual(['g', 'policy']);
    const ran = await run(argv);
    expect(ran.ok, JSON.stringify(ran.findings)).toBe(true);
    expect(Object.keys(await loaded())).toContain('canInvoiceRead');
  });

  test('--force on a slice policy appends too: never a rewrite of the rules already there', async () => {
    const before = await Bun.file(join(root, policyPath)).text();
    const result = await run(['g', 'policy', 'approval', '--feature', 'invoice', '--force']);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    expect((await Bun.file(join(root, policyPath)).text()).startsWith(before.trimEnd())).toBe(true);
  });

  test('grants what the policy declares, never what its slice is called', async () => {
    const result = await run(['g', 'policy', 'approval', '--feature', 'invoice']);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    const roles = await Bun.file(join(root, ROLES_FILE)).text();
    // `member` reads and `admin` writes, as for a slice's first set — under the set's own name.
    expect(roles).toMatch(/member: \{[^}]*'approval:read'/);
    expect(roles).toMatch(/admin: \{[^}]*'approval:write'/);
    expect(result.findings?.some((one) => one.code === 'X_PERMISSION_UNGRANTED')).toBe(false);
  });

  test('grants only the set this run wrote: a hand-placed admin-only permission stays ungranted', async () => {
    const path = join(root, policyPath);
    await Bun.write(
      path,
      `${await Bun.file(path).text()}\nexport const payroll = definePermissions(['payroll:read']);\n`,
    );
    const result = await run(['g', 'policy', 'approval', '--feature', 'invoice']);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    const roles = await Bun.file(join(root, ROLES_FILE)).text();
    expect(roles).toContain("'approval:read'");
    expect(roles).not.toContain('payroll:read');
    // Nor the slice's first set, which this run did not write.
    expect(roles).not.toContain('invoice:');
  });
});
