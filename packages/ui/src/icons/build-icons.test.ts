// The generator is only trustworthy if its output is checked, so this covers both halves: the
// pure transform (upstream JSON → module text) and the 1700-odd modules actually committed —
// every one of them has to import, export the name its path promises, and survive the glyph gate.

import { describe, expect, test } from 'bun:test';
import type { IconGlyph } from '../components/icon-glyph';
import { iconElements } from '../components/icon-glyph';
import { UI_ERROR_CODES } from '../errors';
import {
  GLYPHS_DIR,
  identifierFor,
  LUCIDE_ICON_NODES_URL,
  LUCIDE_VERSION,
  moduleSource,
  parseIconNodes,
  SAFE_ATTR_VALUE,
  SAFE_ICON_NAME,
  withPin,
} from './build-icons';

/** `expect(fn).toThrow(Class)` passes in Bun 1.4.0 when `fn` merely RETURNS an error, so the
 * code is read off the caught value instead (issue #150). */
function caught(run: () => unknown): { code?: unknown; cause?: unknown; fix?: unknown } {
  try {
    run();
  } catch (error) {
    return error as { code?: unknown };
  }
  return expect.unreachable('expected the call to throw, and it returned');
}

const NODES = JSON.stringify({
  search: [
    ['path', { d: 'm21 21-4.34-4.34', key: 'k1' }],
    ['circle', { cx: '11', cy: 11, r: '8', key: 'k2' }],
  ],
});

describe('parseIconNodes', () => {
  test('drops the upstream diff key and stringifies numbers', () => {
    expect(parseIconNodes(NODES).get('search')).toEqual([
      ['path', { d: 'm21 21-4.34-4.34' }],
      ['circle', { cx: '11', cy: '11', r: '8' }],
    ]);
  });

  test('refuses data the component would refuse at render time', () => {
    expect(() => parseIconNodes(JSON.stringify({ bad: [['script', {}]] }))).toThrow(/script/);
    expect(() => parseIconNodes(JSON.stringify({ empty: [] }))).toThrow(/renderable node data/);
  });

  test('a JSON array is not an icon table', () => {
    expect(() => parseIconNodes('[]')).toThrow(/icon-nodes\.json/);
  });

  // Malformed upstream data is X_UI_INVALID_VALUE, never X_UI_RUNTIME_MISSING: the operator who
  // reads "is not available in this environment" goes and audits their environment for a fault
  // that is in the file they just downloaded. The generator's real environment faults — no
  // network, no biome binary — keep the runtime code.
  test('bad upstream data is an invalid VALUE, not a missing runtime', () => {
    expect(caught(() => parseIconNodes('[]')).code).toBe(UI_ERROR_CODES.invalidValue);
    expect(caught(() => parseIconNodes(JSON.stringify({ empty: [] }))).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });

  test('a body that is not JSON at all is the same invalid VALUE, naming the URL', () => {
    // A CDN error page, a captive portal, a truncated download: `JSON.parse` threw a bare
    // `SyntaxError` here, which no fix line accompanies.
    for (const body of ['<html>502</html>', '{"search": [', '']) {
      const error = caught(() => parseIconNodes(body));
      expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
      expect(String(error.cause)).toContain(LUCIDE_ICON_NODES_URL);
      expect(String(error.fix)).toContain('bun run --filter @ultimat3/ui icons');
    }
  });

  test('a node that is not a [tag, attrs] pair is refused, never skipped into a partial glyph', () => {
    for (const node of ['path', 7, null, [], [3, {}], ['path', 'd'], ['path', ['d']]]) {
      const table = JSON.stringify({ search: [['path', { d: 'm21 21-4.34-4.34' }], node] });
      const error = caught(() => parseIconNodes(table));
      expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
      expect(String(error.cause)).toContain('"search"');
    }
    // An icon whose value is not a list of nodes at all is refused the same way.
    expect(caught(() => parseIconNodes(JSON.stringify({ search: 'path' }))).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });

  test('an attribute value that is not glyph geometry never reaches the generator', () => {
    const hostile = JSON.stringify({
      evil: [['path', { d: "M0 0');console.log('pwned" }]],
    });
    const error = caught(() => parseIconNodes(hostile));
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    expect(String(error.fix)).toContain('bun run --filter @ultimat3/ui icons');
  });
});

describe('SAFE_ATTR_VALUE', () => {
  test('accepts glyph geometry and refuses anything that could close a string literal', () => {
    expect(SAFE_ATTR_VALUE.test('m21 21-4.34-4.34')).toBe(true);
    expect(SAFE_ATTR_VALUE.test('12 2 2 7 12 12 22 7 12 2')).toBe(true);
    expect(SAFE_ATTR_VALUE.test('currentColor')).toBe(true);
    expect(SAFE_ATTR_VALUE.test("M0 0');x()//")).toBe(false);
    expect(SAFE_ATTR_VALUE.test('M0 0"')).toBe(false);
    expect(SAFE_ATTR_VALUE.test('M0 0\\')).toBe(false);
  });
});

describe('identifierFor', () => {
  test('prefixes so reserved words stay legal identifiers', () => {
    expect(identifierFor('circle-alert')).toBe('iconCircleAlert');
    expect(identifierFor('delete')).toBe('iconDelete');
    expect(identifierFor('a-arrow-down')).toBe('iconAArrowDown');
  });
});

describe('moduleSource', () => {
  test('carries the generated banner, the licence line and the typed export', () => {
    const source = moduleSource('search', [['path', { d: 'M0 0' }]]);
    expect(source).toContain('GENERATED by src/icons/build-icons.ts');
    expect(source).toContain('Lucide contributors, ISC');
    expect(source).toContain("import type { IconGlyph } from '../../components/icon-glyph';");
    expect(source).toContain('export const iconSearch: IconGlyph = [');
    // Double quotes here, single quotes on disk: `format()` runs Biome over the written files, so
    // the committed set is byte-identical to what it was before the escaping changed.
    expect(source).toContain('[\'path\', { d: "M0 0" }],');
  });

  /**
   * The value is network-fetched data on its way into a TypeScript module that every app importing
   * that icon EXECUTES at import — a code sink, not an attribute sink. The payload below is a
   * WORKING escape from the old `'${value}'`: it closes the string, the object and the array
   * element, runs a statement, and reopens all three so the module still parses. Evaluated here
   * rather than pattern-matched, because a substring assertion is satisfied by escaping that only
   * looks right.
   */
  test('an attribute value is emitted as DATA, never as source it could break out of', () => {
    const payload = "x' }], (globalThis.__uiIconPwned = true), ['path', { d: 'y";
    const source = moduleSource('evil', [['path', { d: payload }]]);
    const js = new Bun.Transpiler({ loader: 'ts' })
      .transformSync(source)
      .replace('export const', 'const');

    const glyph: unknown = new Function(`${js}\nreturn iconEvil;`)();

    expect(Reflect.get(globalThis, '__uiIconPwned')).toBeUndefined();
    expect(glyph).toEqual([['path', { d: payload }]]);
  });

  test('a value carrying a quote or a backslash round-trips as the same string', () => {
    for (const value of ["a'b", 'a\\b', 'a\nb', 'a"b']) {
      const source = moduleSource('probe', [['path', { d: value }]]);
      const literal = /\{ d: (.*) \}/.exec(source)?.[1] ?? '';
      expect(JSON.parse(literal)).toBe(value);
    }
  });
});

describe('the committed glyph set', () => {
  const files = [...new Bun.Glob('*.ts').scanSync({ cwd: GLYPHS_DIR })].sort();

  test('wraps the whole upstream set, not a hand-picked corner of it', () => {
    expect(files.length).toBeGreaterThan(1500);
  });

  test('every module exports the identifier its path promises, and it is a valid glyph', async () => {
    const broken: string[] = [];
    for (const file of files) {
      const name = file.slice(0, -3);
      const module: Record<string, unknown> = await import(`${GLYPHS_DIR}${file}`);
      const glyph = module[identifierFor(name)];
      if (glyph === undefined) {
        broken.push(`${name}: no export named ${identifierFor(name)}`);
        continue;
      }
      // The namespace is `unknown`-valued on purpose: `iconElements` is what decides whether
      // what the module exported is renderable, and it throws when it is not.
      if (iconElements(glyph as IconGlyph).length === 0) broken.push(`${name}: empty glyph`);
      for (const [, attrs] of glyph as IconGlyph) {
        for (const [key, value] of Object.entries(attrs)) {
          // The guard, measured against the artwork it has to let through: all 1767 committed
          // glyphs pass, so `SAFE_ATTR_VALUE` refuses no legitimate Lucide icon.
          if (!SAFE_ATTR_VALUE.test(value)) broken.push(`${name}: ${key}="${value}"`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test('the pinned upstream version is a real semver, so a bump is visible in the diff', () => {
    expect(LUCIDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// Axiom 4: a `fix:` is what its reader RUNS. Everything that decides whether running it helps —
// which URL served the file, which pinned version published the glyph — is the CAUSE's job, so
// these assert the two halves separately rather than that the sentence reads well.
describe('withPin', () => {
  const FILE = "// x\nexport const LUCIDE_VERSION = '1.31.0';\nconst y = 1;\n";

  test('rewrites exactly the pin line, and nothing else', () => {
    expect(withPin(FILE, '1.50.0')).toBe(FILE.replace('1.31.0', '1.50.0'));
  });

  test('a version that is not plain semver never reaches the source', () => {
    for (const bad of ["1.0.0'; evil()", '', 'latest', '1.0']) {
      expect(caught(() => withPin(FILE, bad)).code).toBe(UI_ERROR_CODES.invalidValue);
    }
  });

  test('a file with no pin line is refused rather than left untouched and reported bumped', () => {
    expect(caught(() => withPin('const y = 1;\n', '1.50.0')).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });
});

describe('the generator’s errors are instructions', () => {
  const ICONS = 'bun run --filter @ultimat3/ui icons';
  const BUMP = `${ICONS} --bump`;

  test('a file that was served wrong is fixed by re-running the generator, exactly', () => {
    for (const bad of ['[]', '<html>502</html>']) {
      expect(caught(() => parseIconNodes(bad)).fix).toBe(ICONS);
    }
  });

  test('data the PIN published is fixed by moving the pin — one command, no comment to obey', () => {
    for (const bad of [
      JSON.stringify({ empty: [] }),
      JSON.stringify({ evil: [['path', { d: "M0 0');x" }]] }),
      JSON.stringify({ search: ['path'] }),
      JSON.stringify({ 'Bad Name': [['path', { d: 'M0 0' }]] }),
    ]) {
      expect(caught(() => parseIconNodes(bad)).fix).toBe(BUMP);
    }
  });

  test('no fix in the generator carries a shell comment or a prose prefix', async () => {
    const source = await Bun.file(new URL('./build-icons.ts', import.meta.url)).text();
    const fixes = [...source.matchAll(/^\s*(?:'|`)((?:bun|bunx|curl) [^'`]*)(?:'|`),?$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(fixes.length).toBeGreaterThanOrEqual(5);
    expect(fixes.filter((fix) => fix.includes('#') || /\bthen\b|^run:/.test(fix))).toEqual([]);
  });

  test('the URL that served the wrong file is named in the cause, not the fix', () => {
    const error = caught(() => parseIconNodes('[]'));
    expect(String(error.cause)).toContain(LUCIDE_ICON_NODES_URL);
    expect(String(error.fix)).not.toContain(LUCIDE_ICON_NODES_URL);
  });

  test('data the pin cannot fix says which pin, and the fix says to move it first', () => {
    const error = caught(() =>
      parseIconNodes(JSON.stringify({ evil: [['path', { d: "M0 0');x" }]] })),
    );
    // Re-running against the same pin repeats this error, so the cause has to name the pin.
    expect(String(error.cause)).toContain(LUCIDE_VERSION);
    expect(String(error.cause)).toContain('LUCIDE_VERSION in packages/ui/src/icons/build-icons.ts');
    expect(String(caught(() => parseIconNodes(JSON.stringify({ empty: [] }))).cause)).toContain(
      LUCIDE_VERSION,
    );
  });
});

/**
 * The map KEY is the third sink and the one that was unguarded: it becomes a filesystem path
 * (`Bun.write(`${GLYPHS_DIR}${name}.ts`)`), a TypeScript identifier and a `//` banner comment. A
 * traversing key writes outside the glyph directory — and `buildIcons` clears that directory
 * first, so a poisoned key set deletes the tree and then overwrites repo files.
 */
describe('the icon NAME is validated before it reaches a sink', () => {
  test('a traversing key never reaches the map', () => {
    const hostile = JSON.stringify({ '../../index': [['path', { d: 'M0 0' }]] });
    const error = caught(() => parseIconNodes(hostile));
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    // The pin published the name, so the line its reader RUNS is the one that moves the pin.
    expect(error.fix).toBe('bun run --filter @ultimat3/ui icons --bump');
    expect(String(error.cause)).toContain(LUCIDE_VERSION);
  });

  test('a key that would carry code into the emitted module is refused', () => {
    for (const key of [
      'a = 0; export const OWNED = ((globalThis as any).x = 1); const u',
      'a\nexport const pwned = 1',
      'Search',
      'a--b',
      '-a',
      'a-',
      '',
      'a_b',
      'a.b',
    ]) {
      expect(
        caught(() => parseIconNodes(JSON.stringify({ [key]: [['path', { d: 'M0 0' }]] }))).code,
      ).toBe(UI_ERROR_CODES.invalidValue);
    }
  });

  test('SAFE_ICON_NAME accepts the shape the committed set actually uses', () => {
    for (const name of ['search', 'circle-alert', 'a-arrow-down', 'square-3', 'x']) {
      expect(SAFE_ICON_NAME.test(name)).toBe(true);
    }
  });

  test('every committed glyph file name passes the allowlist', () => {
    const names = [...new Bun.Glob('*.ts').scanSync({ cwd: GLYPHS_DIR })].map((f) =>
      f.slice(0, -3),
    );
    expect(names.filter((name) => !SAFE_ICON_NAME.test(name))).toEqual([]);
  });
});
