// `X_GENERATE_CONFLICT` on a slice module the author owns. Its fix printed a literal `<name>` — a
// shell redirect when pasted — and offered `x g query … --feature ship` on a slice with no entity,
// which `X_FEATURE_REQUIRED` then refuses. Each printed line is run here, not read.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generate, generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { rolesFiles } from './templates/scaffold-roles';

let root = '';

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/** The fix line as argv: the command before a `#` comment, `x` dropped, quotes stripped. */
const argvOf = (fix: string): readonly string[] =>
  (fix.split('#')[0] ?? '')
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((word) => word.replace(/^'(.*)'$/, '$1'));

const conflictOf = async (argv: readonly string[]): Promise<string> => {
  const result = await generateCommand.run(contextFor(argv));
  const fix = result.findings?.find((one) => one.code === 'X_GENERATE_CONFLICT')?.fix;
  if (fix === undefined) return expect.unreachable(`${argv.join(' ')} raised no conflict`);
  return fix;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-conflict-fix-'));
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("unit · a conflict on the author's slice module hands back a line that runs", () => {
  test('x g policy on its own set again: a second set that appends, never another kind', async () => {
    // The author's own policy and the scaffold's role map, so the fix's run can grant and be `ok`.
    for (const file of [...rolesFiles(), ...generate({ kind: 'policy', name: 'ship' })]) {
      if (typeof file.contents === 'string') await Bun.write(join(root, file.path), file.contents);
    }
    const fix = await conflictOf(['g', 'policy', 'ship']);
    expect(fix.split('#')[0]).not.toMatch(/<[a-z]/i);
    expect(fix).not.toContain('x g query');
    expect(fix).not.toContain('--force');
    expect(fix).toStartWith('x g policy ship-admin --feature ship');
    const ran = await generateCommand.run(contextFor(argvOf(fix)));
    expect(ran.ok, JSON.stringify(ran.findings)).toBe(true);
  });

  test('a slice holding its entity: x g query is offered, with the caller own name', async () => {
    for (const file of generate({ kind: 'entity', name: 'post' })) {
      if (typeof file.contents === 'string') await Bun.write(join(root, file.path), file.contents);
    }
    const fix = await conflictOf(['g', 'entity', 'post']);
    expect(fix.split('#')[0]).not.toMatch(/<[a-z]/i);
    expect(fix).toContain('x g query post --feature post');
    expect(fix).not.toContain('<name>');
  });
});
