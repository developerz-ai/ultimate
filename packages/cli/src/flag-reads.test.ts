import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFlagReads, declaredFlags, readsFlag } from './flag-reads';
import type { CommandSpec } from './parse';
import { SPECS } from './registry';

const spec = (name: string, flags: CommandSpec['flags']): CommandSpec => ({
  name,
  summary: 's',
  usage: `x ${name}`,
  ...(flags === undefined ? {} : { flags }),
});

describe('declaredFlags', () => {
  test('lists a command’s own flags with the command that declares them', () => {
    const specs = [spec('deploy', [{ name: 'critical', type: 'boolean', summary: 'security' }])];
    expect(declaredFlags(specs)).toEqual([
      { command: 'deploy', flag: { name: 'critical', type: 'boolean', summary: 'security' } },
    ]);
  });

  // The parser and the dispatcher read these once, for every command. A per-command rule would
  // report all thirty declarations of `--json` as unread and be turned off the same afternoon.
  test('the global flags are the parser’s, and are never a command’s to read', () => {
    const specs = [
      spec('deploy', [{ name: 'json', type: 'boolean', summary: 'machine-readable' }]),
    ];
    expect(declaredFlags(specs)).toEqual([]);
  });
});

describe('readsFlag', () => {
  test('a declaration is not a read', () => {
    expect(readsFlag("{ name: 'critical', type: 'boolean', summary: 'x' }", 'critical')).toBe(
      false,
    );
    expect(readsFlag("{ short: 'j', name: 'json' }", 'j')).toBe(false);
  });

  test('any other occurrence of the bare literal is one', () => {
    expect(readsFlag("flagBool(ctx.args, 'critical')", 'critical')).toBe(true);
    // Read through a shared constant rather than by name at the call site — still read.
    expect(readsFlag("const CRITICAL = 'critical';", 'critical')).toBe(true);
  });

  // The name inside a longer string is a citation, never a read: `x deploy --critical` in a `fix:`
  // line is the flag being NAMED to a reader, which is the very case that shipped unimplemented.
  test('the name inside a longer string is not a read', () => {
    expect(readsFlag("fix: 'x deploy --critical --json'", 'critical')).toBe(false);
  });
});

describe('checkFlagReads', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flag-reads-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const DECLARED = "flags: [{ name: 'critical', type: 'boolean', summary: 'forces a reload' }]";

  test('a flag nothing reads is a finding naming the file that declares it', async () => {
    await write('cmd-deploy.ts', `export const deployCommand = { spec: { ${DECLARED} } };\n`);
    const [finding, ...rest] = await checkFlagReads(
      [spec('deploy', [{ name: 'critical', type: 'boolean', summary: 'forces a reload' }])],
      root,
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_CLI_FLAG_UNREAD');
    expect(finding?.cause).toContain('x deploy declares --critical');
    expect(finding?.at).toContain('cmd-deploy.ts');
    expect(finding?.fix).toContain("flagBool(ctx.args, 'critical')");
  });

  test('a reader anywhere in the source, not only in the declaring file, satisfies it', async () => {
    await write('cmd-deploy.ts', `export const deployCommand = { spec: { ${DECLARED} } };\n`);
    await write(
      'deploy-plan.ts',
      "export const critical = (args) => flagBool(args, 'critical');\n",
    );
    expect(
      await checkFlagReads(
        [spec('deploy', [{ name: 'critical', type: 'boolean', summary: 'forces a reload' }])],
        root,
      ),
    ).toEqual([]);
  });

  // A flag named only in the prose above its spec is exactly the flag most likely to be dead.
  test('a mention in a comment is not a reader', async () => {
    await write(
      'cmd-deploy.ts',
      `// 'critical' is handled below\nexport const deployCommand = { spec: { ${DECLARED} } };\n`,
    );
    expect(
      await checkFlagReads(
        [spec('deploy', [{ name: 'critical', type: 'boolean', summary: 'forces a reload' }])],
        root,
      ),
    ).toHaveLength(1);
  });

  // A test asserting on a flag is not a command reading one; the suite is not shipped behaviour.
  test('a test file is not a reader', async () => {
    await write('cmd-deploy.ts', `export const deployCommand = { spec: { ${DECLARED} } };\n`);
    await write('cmd-deploy.test.ts', "expect(flagBool(args, 'critical')).toBe(true);\n");
    expect(
      await checkFlagReads(
        [spec('deploy', [{ name: 'critical', type: 'boolean', summary: 'forces a reload' }])],
        root,
      ),
    ).toHaveLength(1);
  });
});

// The rule applied to this build, which is what makes it a build error rather than a utility.
// It answers zero today: `--critical` IS read — `cmd-deploy.ts` writes it into the plan JSON —
// and what was unimplemented was the plan field's consumer, one level below any rule over names.
describe('this CLI', () => {
  test('every flag every command declares is read by something', async () => {
    expect(await checkFlagReads(SPECS, import.meta.dir)).toEqual([]);
  }, 15_000);

  test('a root with no CLI source decides nothing, rather than reporting every flag', async () => {
    // `tierBoundaries` runs against fixture roots that ship no `packages/cli/src`. Reporting all 30
    // declared flags there would be the false-positive direction; throwing ENOENT would be worse.
    const empty = join(await mkdtemp(join(tmpdir(), 'flag-reads-')), 'src');
    await mkdir(empty, { recursive: true });

    expect(await checkFlagReads(SPECS, empty)).toEqual([]);
  });
});
