// The purity scanner, rule by rule. Its whole promise is that ONE file's text answers "this module
// graph reaches no browser" — so the cases that matter are the edges it cannot follow, and the one
// spelling that is not an edge at all: `import type`, which `verbatimModuleSyntax` erases.

import { describe, expect, test } from 'bun:test';
// why: no Bun native creates or removes a directory tree, and the erasure proof needs two real
// files on disk — a `data:` module cannot have a sibling.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: same — Bun.write and import() both take a joined path.
import { assertIslandStatesPure, islandStatesFault, moduleEdges } from './island-states-pure';
import { testName } from './test-types';

const FILE = 'apps/web/app/settings/settings.island.states.ts';

/** The fault's specifier, or `undefined` — the shape most cases below assert on. */
const faultAt = (source: string): string | undefined => islandStatesFault(source)?.specifier;

describe(testName('unit', 'a states file may not import a sibling at runtime'), () => {
  /**
   * The hole this file was written for. `./settings.island` resolves to `./settings.island.tsx`
   * under Bun — proved below against a real pair of files — so an extension check alone reports
   * PURE for a file that drags Solid into a browser-free process.
   */
  test('an extensionless import of the component is refused, naming it', () => {
    const source = "import { Settings } from './settings.island';\n";
    expect(faultAt(source)).toBe('./settings.island');
    expect(islandStatesFault(source)?.kind).toBe('sibling');
    expect(() => assertIslandStatesPure(FILE, source)).toThrow();
  });

  test('the refusal carries the code and the edit, and names the specifier', () => {
    try {
      assertIslandStatesPure(FILE, "import { Settings } from './settings.island';\n");
      expect.unreachable('a value import of a sibling is a module graph this check cannot follow');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATES_NOT_PURE');
      expect((error as { cause: string }).cause).toContain('./settings.island');
      expect((error as { fix: string }).fix).toContain('import type');
    }
  });

  /**
   * Not only the component: `./helpers` may import it, and this scanner reads ONE file. A relative
   * target whose graph it cannot follow is the rule, not the `.island` stem — which is also why
   * nothing here restates `@ultimat3/render`'s island extension.
   */
  test('any relative value import is refused, not only one that looks like the island', () => {
    expect(faultAt("import { BASE } from './helpers';")).toBe('./helpers');
    expect(faultAt("import { BASE } from '../shared/props';")).toBe('../shared/props');
    expect(faultAt("import './side-effect';")).toBe('./side-effect');
    // A directory index is the same edge with the module name left off.
    expect(faultAt("import { Settings } from './components';")).toBe('./components');
    // The most surprising refusal of the rule, stated: a states file takes no stylesheet either,
    // and every relative target is one this scanner cannot follow.
    expect(faultAt("import './styles.css';")).toBe('./styles.css');
  });

  test('every runtime spelling of the edge is read', () => {
    expect(faultAt("export { Settings } from './settings.island';")).toBe('./settings.island');
    expect(faultAt("const m = await import('./settings.island');")).toBe('./settings.island');
    expect(faultAt("require('./settings.island');")).toBe('./settings.island');
    expect(faultAt("export * from './settings.island';")).toBe('./settings.island');
  });

  /**
   * A specifier the scanner cannot read is a specifier it cannot judge, and answering PURE over it
   * is the same optimism the extensionless case shipped with.
   */
  test('a computed specifier is refused as unreadable rather than assumed pure', () => {
    // Written with an escaped interpolation so the SOURCE under test holds a template specifier.
    const fault = islandStatesFault(`const m = await import(\`./\${name}.island\`);`);
    expect(fault?.kind).toBe('opaque');
    expect(fault?.specifier).toContain(`\${name}`);
    expect(faultAt('const m = await import(SPEC);')).toBe('SPEC');
  });

  test('a relative .json import is data and is allowed — a JSON module imports nothing', () => {
    expect(faultAt("import props from './props.json' with { type: 'json' };")).toBeUndefined();
  });
});

describe(
  testName('unit', 'import type is erased, and is the one way to reach the component'),
  () => {
    test("a type-only import of the sibling is pure, in both the file's spellings", () => {
      expect(faultAt("import type { SettingsProps } from './settings.island';")).toBeUndefined();
      expect(faultAt("export type { SettingsProps } from './settings.island';")).toBeUndefined();
      expect(faultAt("import type * as S from './settings.island';")).toBeUndefined();
      // A LOOSENING, deliberate and pinned so it can be argued with: a type-only import of the
      // `.tsx` itself was refused before 2026-08-23. It is erased by the same keyword, so refusing
      // it would leave two spellings of one safe thing with only one of them allowed.
      expect(faultAt("import type { P } from './settings.island.tsx';")).toBeUndefined();
      // The reference app's line, verbatim — the rule may never refuse it.
      expect(
        faultAt(
          "import { defineIslandStates } from '@ultimat3/testing';\nimport type { SettingsProps } from './settings.island';",
        ),
      ).toBeUndefined();
    });

    /**
     * The other direction, and it is the one that would leave the hole open: `verbatimModuleSyntax`
     * erases a statement that starts `import type`, and KEEPS `import { type X }` — it emits
     * `import {} from './y'`, which evaluates the module. An inline `type` is not an erasure.
     */
    test('an inline type modifier keeps the statement, so it is still a runtime edge', () => {
      expect(faultAt("import { type SettingsProps } from './settings.island';")).toBe(
        './settings.island',
      );
      expect(faultAt("export { type SettingsProps } from './settings.island';")).toBe(
        './settings.island',
      );
    });

    test('an identifier that merely starts with "type" is a value import', () => {
      expect(faultAt("import types from './settings.island';")).toBe('./settings.island');
      expect(faultAt("import typeOf from './settings.island';")).toBe('./settings.island');
    });

    test('the edges are reported with the distinction that decides it', () => {
      expect(moduleEdges("import type { A } from './a';")).toEqual([
        { specifier: './a', typeOnly: true },
      ]);
      expect(moduleEdges("import { A } from './a';")).toEqual([
        { specifier: './a', typeOnly: false },
      ]);
    });
  },
);

describe(testName('unit', 'what the scanner still refuses, and what it never did'), () => {
  test('solid-js and a JSX specifier are unchanged', () => {
    expect(faultAt("import { createSignal } from 'solid-js';")).toBe('solid-js');
    expect(faultAt("require('solid-js/web');")).toBe('solid-js/web');
    expect(faultAt("import { Settings } from './settings.island.tsx';")).toBe(
      './settings.island.tsx',
    );
    expect(islandStatesFault("import { S } from './s.island.tsx';")?.kind).toBe('browser');
  });

  test('a package specifier is allowed, and a specifier in a comment is not an import', () => {
    expect(faultAt("import { defineIslandStates } from '@ultimat3/testing';")).toBeUndefined();
    expect(faultAt("import { t } from '@ultimat3/i18n';")).toBeUndefined();
    expect(faultAt("// never import './settings.island' here\n")).toBeUndefined();
    expect(faultAt("/* import { S } from './settings.island'; */\n")).toBeUndefined();
  });
});

describe(testName('unit', 'the erasure the type-only exemption rests on'), () => {
  /**
   * Asserted against Bun rather than believed: the exemption is only safe because a `import type`
   * statement never evaluates its target. If Bun ever kept it, every rule above would be wrong in
   * the dangerous direction and this is the case that says so.
   */
  test('a type-only import does not evaluate the sibling; a value import does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ultimate-island-erasure-'));
    try {
      await Bun.write(
        join(root, 'x.island.tsx'),
        'export interface P { a: string }\nexport const evaluated = (globalThis as Record<string, unknown>).__islandEvaluated = true;\n',
      );
      await Bun.write(
        join(root, 'type-only.ts'),
        "import type { P } from './x.island';\nexport const props: P = { a: 'a' };\n",
      );
      await Bun.write(
        join(root, 'value.ts'),
        "import { evaluated } from './x.island';\nexport const used = evaluated;\n",
      );
      const flag = (): unknown => (globalThis as Record<string, unknown>)['__islandEvaluated'];

      await import(join(root, 'type-only.ts'));
      expect(flag()).toBeUndefined();

      // The same specifier, one keyword apart: the extensionless path resolves to the `.tsx`.
      await import(join(root, 'value.ts'));
      expect(flag()).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>)['__islandEvaluated'];
      rmSync(root, { recursive: true, force: true });
    }
  });
});
