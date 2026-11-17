// `sideEffectsResult` over a fixture tree: the check's verdict, `--explain`'s measurement, and the
// three answers `--unpin` can give — a typo refused, a still-silent package left alone, a declared
// one lowered by editing the fixture's own copy of the pin array.

import { describe, expect, test } from 'bun:test';
import { tempTree } from '../packages/testing/src/temp-tree';
import { parseScriptArgs } from './lib/args';
import { PINS_FILE, SIDE_EFFECTS_UNDECLARED, sideEffectsResult } from './side-effects';

/** A ratchet row that exists today; the `--unpin` tests are about one, whichever it is. */
const PINNED = SIDE_EFFECTS_UNDECLARED[0] ?? 'packages/none';

/** One package at `dir` whose entry runs a call at import time; `sideEffects` as given. */
async function pkg(root: string, dir: string, sideEffects?: false | readonly string[]) {
  await Bun.write(
    `${root}/${dir}/package.json`,
    JSON.stringify({
      name: `@ultimat3/${dir.split('/')[1]}`,
      exports: { '.': './src/index.ts' },
      ...(sideEffects === undefined ? {} : { sideEffects }),
    }),
  );
  await Bun.write(
    `${root}/${dir}/src/index.ts`,
    "registerErrorCodes({ X_FIXTURE: 'a fixture' });\nexport const one = 1;\n",
  );
}

const result = (root: string, argv: readonly string[]) =>
  sideEffectsResult(parseScriptArgs(argv), root);

describe('sideEffectsResult', () => {
  test('a package that declares nothing and is not on the ratchet is X_SIDE_EFFECTS_MISSING', async () => {
    await using tree = tempTree('side-effects-run-');
    await pkg(tree.path, 'packages/zzfixture');
    const out = await result(tree.path, []);
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/sideEffects gap\(s\)$/);
    expect(out.findings?.map((finding) => finding.code)).toContain('X_SIDE_EFFECTS_MISSING');
  });

  test('a tree with no package is a vacuous scan, never a clean one', async () => {
    await using tree = tempTree('side-effects-run-');
    const out = await result(tree.path, []);
    expect(out.ok).toBe(false);
    expect(out.findings?.map((finding) => finding.code)).toEqual(['X_SIDE_EFFECTS_UNSCANNED']);
  });

  test('--explain measures each package’s import-time effects', async () => {
    await using tree = tempTree('side-effects-run-');
    await pkg(tree.path, 'packages/zzfixture');
    const out = await result(tree.path, ['--explain']);
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('measured import-time effects in 1 package(s)');
    expect(out.lines).toEqual(['  packages/zzfixture: ["./src/index.ts"]']);
  });

  test('--unpin with a name not on the ratchet is a bad flag, and writes nothing', async () => {
    await using tree = tempTree('side-effects-run-');
    const out = await result(tree.path, ['--unpin', 'packages/does-not-exist']);
    expect(out.ok).toBe(false);
    expect(out.findings?.map((finding) => finding.code)).toEqual(['X_CLI_BAD_FLAG']);
    expect(out.summary).toContain('packages/does-not-exist, which is not on the ratchet');
  });

  test('--unpin leaves a still-silent package on the ratchet', async () => {
    await using tree = tempTree('side-effects-run-');
    await pkg(tree.path, PINNED);
    const out = await result(tree.path, ['--unpin', PINNED]);
    expect(out).toMatchObject({
      ok: true,
      summary: 'nothing to lower — every named package still declares no sideEffects',
    });
  });

  test('--unpin lowers a package that now declares, by editing the pin array', async () => {
    await using tree = tempTree('side-effects-run-');
    await pkg(tree.path, PINNED, ['./src/index.ts']);
    await Bun.write(`${tree.path}/${PINS_FILE}`, Bun.file(`${import.meta.dir}/side-effects.ts`));
    const out = await result(tree.path, ['--unpin', PINNED]);
    expect(out).toMatchObject({ ok: true, summary: `lowered 1 pin(s): ${PINNED}` });
    const edited = await Bun.file(`${tree.path}/${PINS_FILE}`).text();
    expect(edited).not.toContain(`  '${PINNED}',\n`);
    expect(edited).toContain(`  '${SIDE_EFFECTS_UNDECLARED[1]}',\n`);
  });
});
