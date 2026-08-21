// The enforcement half of `scripts/side-effects.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `sideEffects` field that stops being true of
// its package fails `bun run verify` with no extra wiring. The real repo is asserted
// NON-VACUOUSLY — a scan that read nothing reports the same clean answer a truthful tree does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import type { PackageFacts, SideEffectGap } from './side-effects';
import {
  checkSideEffects,
  entryMatches,
  PINS_FILE,
  readPackageFacts,
  SIDE_EFFECTS_UNDECLARED,
  scanTopLevelEffects,
  sideEffectFinding,
  sideEffectGaps,
  unknownPins,
} from './side-effects';

const ROOT = repoRoot();
const FIXTURE = join(ROOT, 'scripts', '.side-effects-fixture');

const pkg = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  dir: 'packages/x',
  name: '@ultimat3/x',
  declared: ['./src/errors.ts'],
  files: ['src/errors.ts', 'src/index.ts', 'package.json'],
  effects: [{ path: 'src/errors.ts', line: 12 }],
  ...over,
});

const check = (packages: readonly PackageFacts[], pins: readonly string[] = []) =>
  checkSideEffects({ packages, pins });

describe('scanTopLevelEffects', () => {
  test('reports a call anchored at column 0, and nothing a keyword opens', () => {
    const source = [
      "import { registerErrorCodes } from '@ultimat3/core';",
      'export const X = 1;',
      'const y = compute();',
      'registerErrorCodes({ X_A: 1 });',
      'installRenderLoader();',
      'expect.extend(matchers);',
    ].join('\n');

    expect(scanTopLevelEffects(source)).toEqual([4, 5, 6]);
  });

  test('does NOT report a call quoted inside a template literal — the scaffold-template shape', () => {
    // `packages/render/src/hydrate.ts` and `packages/cli/src/templates/*` both emit whole modules
    // as strings. A guard with a false positive on one of them is worse than no guard: no edit to
    // package.json can ever clear it.
    const source = [
      'export const TEMPLATE = `',
      "registerErrorCodes({ X_APP: { title: 'app' } });",
      'installSomething();',
      '`;',
    ].join('\n');

    expect(scanTopLevelEffects(source)).toEqual([]);
  });

  test('does NOT report a call that is commented out', () => {
    expect(scanTopLevelEffects('// registerErrorCodes({});\n')).toEqual([]);
    expect(scanTopLevelEffects('/*\nregisterErrorCodes({});\n*/\n')).toEqual([]);
  });

  test('reports a top-level assignment, not only a call', () => {
    expect(scanTopLevelEffects('globalThis.__x = 1;\n')).toEqual([1]);
    // An arrow is a declaration's right-hand side, never a statement — `x =>` must not read as one.
    expect(scanTopLevelEffects('type F = (x: number) => number;\n')).toEqual([]);
  });
});

describe('entryMatches', () => {
  test('treats `./src/errors.ts` and `src/errors.ts` as one entry', () => {
    expect(entryMatches('./src/errors.ts', 'src/errors.ts')).toBe(true);
    expect(entryMatches('src/errors.ts', 'src/errors.ts')).toBe(true);
    expect(entryMatches('./src/errors.ts', 'src/index.ts')).toBe(false);
  });

  test('a recursive glob reaches any depth — how `@ultimat3/ui` covers its stylesheets', () => {
    expect(entryMatches('**/*.scss', 'src/tokens/_index.scss')).toBe(true);
    expect(entryMatches('**/*.scss', 'src/index.ts')).toBe(false);
  });
});

describe('a declaration that excludes a side-effecting module', () => {
  test('is reported, with the file and line that runs the statement', () => {
    const gaps = check([
      pkg({ declared: ['./src/errors.ts'], effects: [{ path: 'src/framework.ts', line: 36 }] }),
    ]);

    expect(gaps).toHaveLength(1);
    const finding = sideEffectFinding(gaps[0] as SideEffectGap);
    expect(finding.code).toBe('X_SIDE_EFFECTS_UNDECLARED');
    expect(finding.at).toBe('packages/x/src/framework.ts:36');
    expect(finding.fix).toContain('"./src/framework.ts"');
  });

  test('`false` excludes everything, so every effect is reported', () => {
    const gaps = check([
      pkg({
        declared: false,
        effects: [
          { path: 'src/errors.ts', line: 1 },
          { path: 'src/context.ts', line: 2 },
        ],
      }),
    ]);

    expect(gaps.map((gap) => gap.subject)).toEqual(['src/errors.ts', 'src/context.ts']);
    expect(gaps.every((gap) => gap.kind === 'undeclared')).toBe(true);
  });
});

describe('a declared entry that matches nothing', () => {
  test('is reported — a stale entry reads as a rule that is still in force', () => {
    const gaps = check([pkg({ declared: ['./src/errors.ts', '**/*.scss'] })]);

    expect(gaps).toHaveLength(1);
    const finding = sideEffectFinding(gaps[0] as SideEffectGap);
    expect(finding.code).toBe('X_SIDE_EFFECTS_ENTRY_STALE');
    expect(finding.at).toBe('packages/x/package.json');
    expect(finding.cause).toContain('"**/*.scss"');
  });
});

describe('the ratchet', () => {
  test('a package declaring nothing is reported unless it is pinned', () => {
    const silent = pkg({ declared: undefined });

    expect(check([silent])).toHaveLength(1);
    expect(sideEffectFinding(check([silent])[0] as SideEffectGap).code).toBe(
      'X_SIDE_EFFECTS_MISSING',
    );
    expect(check([silent], ['packages/x'])).toHaveLength(0);
  });

  test('a pin the tree no longer needs is reported, so the ratchet shrinks on its own', () => {
    const gaps = check([pkg()], ['packages/x']);

    expect(gaps).toHaveLength(1);
    const finding = sideEffectFinding(gaps[0] as SideEffectGap);
    expect(finding.code).toBe('X_SIDE_EFFECTS_PIN_STALE');
    expect(finding.at).toBe(PINS_FILE);
    expect(finding.fix).toContain('--unpin packages/x');
  });

  test('a name --unpin cannot act on is refused, not answered "nothing to lower"', () => {
    // `--unpin packages/does-not-exist` used to exit 0 with a sentence about a package that is not
    // in the tree, so a typo in the fix line the gate printed read as success.
    expect(unknownPins(['packages/does-not-exist'])).toEqual(['packages/does-not-exist']);
    expect(unknownPins([SIDE_EFFECTS_UNDECLARED[0] as string])).toEqual([]);
  });
});

describe('vacuity', () => {
  test('a scan that walked no package is a finding, never a clean tree', () => {
    const gaps = check([]);

    expect(gaps).toHaveLength(1);
    expect(sideEffectFinding(gaps[0] as SideEffectGap).code).toBe('X_SIDE_EFFECTS_UNSCANNED');
  });

  test('a tree in which nothing runs at import time is a finding too', () => {
    const gaps = check([pkg({ effects: [] })]);

    expect(gaps).toHaveLength(1);
    expect(sideEffectFinding(gaps[0] as SideEffectGap).cause).toContain('import time');
  });
});

describe('readPackageFacts', () => {
  beforeEach(async () => {
    await rm(FIXTURE, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(FIXTURE, { recursive: true, force: true });
  });

  const write = async (relative: string, text: string): Promise<void> => {
    await Bun.write(join(FIXTURE, relative), text);
  };

  test('walks only what `exports` reaches, so a build script is never demanded in the field', async () => {
    await write(
      'packages/fake/package.json',
      JSON.stringify({ name: '@fake/fake', exports: { '.': './src/index.ts' } }),
    );
    await write('packages/fake/src/index.ts', "import './errors';\nexport const a = 1;\n");
    await write('packages/fake/src/errors.ts', 'registerErrorCodes({});\n');
    // Reachable from nothing the package exports — `packages/cli/src/bin.ts` is the real instance.
    await write('packages/fake/src/build-it.ts', 'process.exit(0);\n');

    const facts = await readPackageFacts(FIXTURE);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.effects).toEqual([{ path: 'src/errors.ts', line: 1 }]);
  });

  /**
   * The boundary the header claims and nothing used to enforce. `join` collapses `..`, so
   * `../../beta/src/effect` resolved to a real file OUTSIDE the package and the reported path was
   * the other package's absolute path sliced at THIS package's length. Measured before the fix:
   * `packages/alpha/rc/effect.ts`, a file in neither package, and the two findings chase each other
   * — the `UNDECLARED` fix asks for the entry, `ENTRY_STALE` refuses it, and `x verify` cannot go
   * green by any edit.
   */
  test('a relative import that LEAVES the package is not this package effect', async () => {
    await write(
      'packages/alpha/package.json',
      JSON.stringify({ name: '@fake/alpha', sideEffects: [], exports: { '.': './src/index.ts' } }),
    );
    await write('packages/alpha/src/index.ts', "export * from '../../beta/src/effect';\n");
    await write(
      'packages/beta/package.json',
      JSON.stringify({
        name: '@fake/beta',
        sideEffects: ['./src/effect.ts'],
        exports: { '.': './src/effect.ts' },
      }),
    );
    await write('packages/beta/src/effect.ts', 'registerErrorCodes({});\nexport const b = 1;\n');

    const facts = await readPackageFacts(FIXTURE);
    const alpha = facts.find((one) => one.dir === 'packages/alpha');
    const beta = facts.find((one) => one.dir === 'packages/beta');
    // beta owns its own effect, and declares it; alpha owns none, so nothing is reported twice.
    expect(alpha?.effects).toEqual([]);
    expect(beta?.effects).toEqual([{ path: 'src/effect.ts', line: 1 }]);
    expect(checkSideEffects({ packages: facts, pins: [] })).toEqual([]);
  });

  test('an exports target that points outside the package is not walked either', async () => {
    await write(
      'packages/alpha/package.json',
      JSON.stringify({ name: '@fake/alpha', sideEffects: [], exports: '../beta/src/effect.ts' }),
    );
    await write('packages/beta/package.json', JSON.stringify({ name: '@fake/beta' }));
    await write('packages/beta/src/effect.ts', 'registerErrorCodes({});\n');

    const facts = await readPackageFacts(FIXTURE);
    expect(facts.find((one) => one.dir === 'packages/alpha')?.effects).toEqual([]);
  });

  test('a module reachable only through a re-export still counts', async () => {
    await write(
      'packages/fake/package.json',
      JSON.stringify({ name: '@fake/fake', exports: './src/index.ts', sideEffects: [] }),
    );
    await write('packages/fake/src/index.ts', "export { a } from './deep/thing';\n");
    await write('packages/fake/src/deep/thing.ts', '\n\nsetUpEverything();\nexport const a = 1;\n');

    const facts = await readPackageFacts(FIXTURE);
    const gaps = checkSideEffects({ packages: facts, pins: [] });

    expect(gaps).toHaveLength(1);
    expect(sideEffectFinding(gaps[0] as SideEffectGap).at).toBe(
      'packages/fake/src/deep/thing.ts:3',
    );
  });
});

describe('this repository', () => {
  test('has no package whose sideEffects field is false of it', async () => {
    expect(await sideEffectGaps(ROOT)).toEqual([]);
  });

  test('measures a real import-time effect in every package that declares one', async () => {
    // Non-vacuity, against the tree rather than a fixture: the four packages swept in this change
    // plus the two swept before it must each still be MEASURED as side-effecting, or the green
    // above is a scan that stopped reading rather than a repo that stayed honest.
    const facts = await readPackageFacts(ROOT);
    const measured = new Map(facts.map((one) => [one.dir, one.effects.map((e) => e.path)]));

    expect(measured.get('packages/core')).toEqual([
      'src/context.ts',
      'src/lifecycle-errors.ts',
      'src/schema-error-codes.ts',
      'src/secrets-errors.ts',
    ]);
    expect(measured.get('packages/i18n')).toEqual(['src/errors.ts', 'src/framework.ts']);
    expect(measured.get('packages/money')).toEqual(['src/errors.ts']);
    // `index.ts` calls `installRenderLoader()` — the barrel itself is the side effect here.
    expect(measured.get('packages/render')).toEqual(['src/errors.ts', 'src/index.ts']);
    expect(measured.get('packages/time')).toEqual(['src/errors.ts']);
    expect(measured.get('packages/ui')).toEqual(['src/errors.ts']);
  });

  test('pins only packages that really declare nothing', async () => {
    const silent = (await readPackageFacts(ROOT))
      .filter((one) => one.declared === undefined)
      .map((one) => one.dir);

    expect([...SIDE_EFFECTS_UNDECLARED].sort()).toEqual([...silent].sort());
  });
});
