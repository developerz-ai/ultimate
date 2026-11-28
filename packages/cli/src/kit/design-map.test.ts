// The kit never advertises an unshipped API: every subpath `design-map.ts` names is in that
// package's `exports`, and every symbol it names is a value export of the file that subpath maps
// to. Read from the export statements (Bun's transpiler scan), not imported: `@ultimat3/effects`
// is tier 5 beside `cli`, and an import — even a test's — is the sideways edge `boundaries` refuses.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DESIGN_MAP, designMapTable } from './design-map';

const REPO = join(import.meta.dir, '../../../..');

/**
 * Symbols whose owner has not landed them yet, each with who ships it. Pending is not skipped
 * forever: once a symbol IS exported, the expiry test below fails until its row here is deleted.
 */
const PENDING: Readonly<Record<string, string>> = {
  '@ultimat3/ui#MotionToggle': 'M1 ships MotionToggle on the ui barrel (plan 101, 06)',
  '@ultimat3/effects#Aurora': 'E1 ships the backgrounds (plan 101, 07)',
  '@ultimat3/effects#GradientOrbs': 'E1 ships the backgrounds (plan 101, 07)',
  '@ultimat3/effects#MosaicGrid': 'E1 ships the backgrounds (plan 101, 07)',
  '@ultimat3/effects#GridGlow': 'E1 ships the backgrounds (plan 101, 07)',
  '@ultimat3/effects#Noise': 'E1 ships the backgrounds (plan 101, 07)',
  '@ultimat3/effects#ShaderBackground': 'E1 ships the shader backgrounds (plan 101, 07)',
  '@ultimat3/effects#EffectCanvas': 'E1 ships effect-canvas.tsx (plan 101, 07)',
};

const PackageJson = (value: unknown): Readonly<Record<string, string>> => {
  const exports =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'exports') : undefined;
  if (typeof exports !== 'object' || exports === null)
    return expect.unreachable('package.json has no exports map');
  return Object.fromEntries(
    Object.entries(exports).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

/** `@ultimat3/ui/motion` → the file it resolves to, or undefined when no export maps it. */
async function entryFile(specifier: string): Promise<string | undefined> {
  const [, pkg = '', ...rest] = specifier.split('/');
  const root = join(REPO, 'packages', pkg);
  const exports = PackageJson(await Bun.file(join(root, 'package.json')).json());
  const target = exports[rest.length === 0 ? '.' : `./${rest.join('/')}`];
  return target === undefined ? undefined : join(root, target);
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' });

/** Value exports only: `export type { … }` is not something an app can call. */
async function valueExports(specifier: string): Promise<ReadonlySet<string>> {
  const file = await entryFile(specifier);
  if (file === undefined) return new Set();
  return new Set(transpiler.scan(await Bun.file(file).text()).exports);
}

const pairs = DESIGN_MAP.flatMap((row) =>
  row.symbols.map((symbol) => ({ from: row.from, symbol, key: `${row.from}#${symbol}` })),
);

describe('unit · the check reads exports, not text', () => {
  test('a symbol a barrel does not export is absent, and a type-only one does not count', () => {
    const scanned = transpiler.scan(
      "export { animate } from './animate';\nexport type { Spring } from './spring';",
    ).exports;
    expect(scanned).toContain('animate');
    expect(scanned).not.toContain('Spring');
    expect(scanned).not.toContain('Presence');
  });
});

describe('unit · every subpath the design map names is in its package exports', () => {
  for (const from of new Set(DESIGN_MAP.map((row) => row.from))) {
    test(`${from} resolves to a file`, async () => {
      const file = await entryFile(from);
      expect({ from, mapped: file !== undefined }).toEqual({ from, mapped: true });
      expect(await Bun.file(file ?? '').exists()).toBe(true);
    });
  }
});

describe('unit · every symbol the design map names is exported from its subpath', () => {
  for (const { from, symbol, key } of pairs) {
    const pending = PENDING[key];
    if (pending !== undefined) {
      test.todo(`${key} — pending: ${pending}`);
      continue;
    }
    test(`${key} is a value export`, async () => {
      expect({ key, exported: (await valueExports(from)).has(symbol) }).toEqual({
        key,
        exported: true,
      });
    });
  }

  test('a pending symbol that has shipped leaves PENDING — pending is never a permanent skip', async () => {
    const shipped: string[] = [];
    for (const { from, symbol, key } of pairs)
      if (PENDING[key] !== undefined && (await valueExports(from)).has(symbol)) shipped.push(key);
    expect(shipped).toEqual([]);
  });

  test('PENDING names only symbols the map still advertises', () => {
    const keys = new Set(pairs.map((pair) => pair.key));
    expect(Object.keys(PENDING).filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe('unit · the table the skill prints is the map', () => {
  test('one row per entry, every symbol and subpath in it', () => {
    const table = designMapTable();
    expect(table.split('\n')).toHaveLength(DESIGN_MAP.length + 2);
    for (const { from, symbol } of pairs) {
      expect(table).toContain(`\`${symbol}\``);
      expect(table).toContain(`\`${from}\``);
    }
  });
});
