import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './boundaries';
import { checkBoundaries, findingFor, packageOf, scopedName } from './boundaries';
import { checkTier, tierOf } from './lib/tiers';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · boundaries', () => {
  test('an upward import is a violation naming the file, the import and the allowed tiers', () => {
    const violations = checkBoundaries([
      file('packages/core/src/index.ts', "import { render } from '@ultimat3/render';"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/core/src/index.ts',
      from: 'core',
      to: 'render',
      fromTier: 0,
      toTier: 4,
      reason: 'upward',
      allowedTiers: '0-0',
    });
  });

  test('the violation renders as a finding with a code, a cause and a fix', () => {
    const violation = checkBoundaries([
      file('packages/http/src/server.ts', "import { db } from '@ultimat3/query';"),
    ])[0];
    if (violation === undefined) expect.unreachable('expected a violation');
    const finding = findingFor(violation);
    expect(finding.code).toBe('X_BOUNDARY_VIOLATION');
    expect(finding.cause).toContain('http (tier 2) imports @ultimat3/query (tier 3)');
    expect(finding.cause).toContain('allowed: 0-1');
    expect(finding.fix.length).toBeGreaterThan(0);
    expect(finding.at).toBe('packages/http/src/server.ts');
  });

  test('a sideways import inside one tier is a violation', () => {
    const violations = checkBoundaries([
      file('packages/action/src/index.ts', "import { subscribe } from '@ultimat3/realtime';"),
    ]);
    expect(violations[0]?.reason).toBe('same-tier');
  });

  test('a strictly lower import is allowed', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/errors.ts', "import { UltimateError } from '@ultimat3/core';"),
        file('packages/policy/src/can.ts', "import { t } from '@ultimat3/i18n';"),
      ]),
    ).toEqual([]);
  });

  test('the one declared sideways edge is allowed and nothing else is', () => {
    expect(
      checkBoundaries([
        file('packages/create-ultimate/src/index.ts', "import { dispatch } from '@ultimat3/cli';"),
      ]),
    ).toEqual([]);
    expect(
      checkBoundaries([
        file('packages/testing/src/harness.ts', "import { dispatch } from '@ultimat3/cli';"),
      ])[0]?.reason,
    ).toBe('same-tier');
  });

  test('an import of a package that is not in the tier table is a violation, not a shrug', () => {
    const violations = checkBoundaries([
      file('packages/cli/src/index.ts', "import { thing } from '@ultimat3/not-a-package';"),
    ]);
    const violation = violations[0];
    if (violation === undefined) expect.unreachable('expected a violation');
    expect(violation.reason).toBe('unknown-package');
    expect(findingFor(violation).fix).toContain('scripts/lib/tiers.ts');
  });

  // Inverted deliberately. This used to assert that a type-only import "does not count", which is
  // the hole: `scanImports` erases the statement, so tier 0 could name tier 5 and the script
  // reported clean — while CLAUDE.md says a tier violation is a build error, full stop.
  test('a type-only import is a violation: the erased statement still couples two packages', () => {
    const violations = checkBoundaries([
      file('packages/core/src/types.ts', "import type { Route } from '@ultimat3/render';"),
    ]);
    expect(violations[0]).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
  });

  test('`export type … from` is caught too, and a type ALIAS is left alone', () => {
    expect(
      checkBoundaries([
        file('packages/schema/src/index.ts', "export type { CliCommand } from '@ultimat3/cli';"),
      ])[0]?.to,
    ).toBe('cli');
    // `export type Foo = string` is not an import; rewriting it would be a syntax error that the
    // transpiler reports instead of the imports this pass exists to find.
    expect(
      checkBoundaries([
        file(
          'packages/render/src/value.ts',
          "export type InterpolationValue = string | number;\nimport { x } from '@ultimat3/core';",
        ),
      ]),
    ).toEqual([]);
  });

  /**
   * The INLINE spelling of the same statement. `dropTypeKeyword` only ever removed the keyword
   * form, so `import { type Foo } from '@ultimat3/cli'` in a tier-0 file was erased by the
   * transpiler and reported clean — the identical edge, spelled the way `useImportType` rewrites
   * a mixed list to. `import { A, type B }` was already seen, which is what made the gap look shut.
   */
  test('an all-inline `{ type X }` import is the same violation as `import type`', () => {
    expect(
      checkBoundaries([
        file('packages/core/src/types.ts', "import { type Route } from '@ultimat3/render';"),
      ])[0],
    ).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
    expect(
      checkBoundaries([
        file('packages/schema/src/index.ts', "export { type CliCommand } from '@ultimat3/cli';"),
      ])[0],
    ).toMatchObject({ from: 'schema', to: 'cli', reason: 'upward' });
    // Several specifiers, a rename, and a multi-line list: all still one import of one package.
    expect(
      checkBoundaries([
        file(
          'packages/core/src/many.ts',
          "import {\n  type Route,\n  type Mode as M,\n} from '@ultimat3/render';",
        ),
      ])[0],
    ).toMatchObject({ to: 'render', reason: 'upward' });
  });

  test('the inline rewrite leaves a lower-tier import and a local type alias alone', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/x.ts', "import { type UltimateError } from '@ultimat3/core';"),
        // `type` as an ordinary binding name is not a modifier, and neither is a property called
        // `type` in an object literal — rewriting either would change what the parser reads.
        file('packages/core/src/y.ts', "import { type } from './kind';\nexport const k = type;"),
        file('packages/core/src/z.ts', "export const step = { type: 'unit' };"),
      ]),
    ).toEqual([]);
  });

  test('a type-only import inside a template literal is not this file’s import', () => {
    // packages/cli/src/templates/*.ts emit generated app source. A regex over raw text would read
    // the generated line as cli's own; the transpiler still sees a string.
    expect(
      checkBoundaries([
        file(
          'packages/core/src/template.ts',
          "export const page = () => `import type { Route } from '@ultimat3/render';`;",
        ),
      ]),
    ).toEqual([]);
  });

  test('a type-position `typeof import(…)` is the same X_BOUNDARY_VIOLATION as `import type`', () => {
    // The slipping form (K16): no import statement at all, so the transpiler erased it whole.
    const violations = checkBoundaries([
      file(
        'packages/testing/src/harness.ts',
        "export type Cli = typeof import('@ultimat3/cli');\n" +
          'export let run: import("@ultimat3/admin").Admin[\'run\'];',
      ),
    ]);
    expect(violations.map((v) => [v.to, v.reason])).toEqual([
      ['cli', 'same-tier'],
      ['admin', 'same-tier'],
    ]);
    const first = violations[0];
    if (first === undefined) expect.unreachable('expected a violation');
    expect(findingFor(first).code).toBe('X_BOUNDARY_VIOLATION');
  });

  test('a type-position `import(…)` inside a string, a template or a comment is not an import', () => {
    expect(
      checkBoundaries([
        file(
          'packages/core/src/template.ts',
          "// typeof import('@ultimat3/cli')\n" +
            'export const a = "typeof import(\'@ultimat3/cli\')";\n' +
            "export const b = `let x: import('@ultimat3/render').Route;`;\n" +
            "export const c = registry.import('@ultimat3/cli');",
        ),
      ]),
    ).toEqual([]);
  });

  test('a RELATIVE cross-package import is checked exactly like the package specifier', () => {
    const violations = checkBoundaries([
      file('packages/core/src/x.ts', "import { render } from '../../render/src/index';"),
    ]);
    expect(violations[0]).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
    // A relative path INSIDE the package is still not a cross-package import.
    expect(
      checkBoundaries([file('packages/core/src/x.ts', "import { y } from './sibling';")]),
    ).toEqual([]);
  });

  test('the declared cli -> testing edge is what serve.live.test.ts imports through', () => {
    expect(
      checkBoundaries([
        file(
          'packages/cli/src/serve.live.test.ts',
          "import { allowHost } from '@ultimat3/testing';",
        ),
      ]),
    ).toEqual([]);
    // …and the relative spelling of the same edge resolves to the same verdict, rather than
    // being invisible the way it was.
    expect(
      checkBoundaries([
        file(
          'packages/cli/src/serve.live.test.ts',
          "import { allowHost } from '../../testing/src/sealed-network';",
        ),
      ]),
    ).toEqual([]);
  });

  test('create-ultimate may import its declared edge and nothing else', () => {
    expect(
      checkBoundaries([
        file('packages/create-ultimate/src/index.ts', "import { dispatch } from '@ultimat3/cli';"),
      ]),
    ).toEqual([]);
    // Above tier 5 used to mean "every framework package is a legal lower-tier import", which made
    // the declared edge restrict nothing at all.
    const violation = checkBoundaries([
      file(
        'packages/create-ultimate/src/index.ts',
        "import { defineRoute } from '@ultimat3/render';",
      ),
    ])[0];
    expect(violation?.reason).toBe('edge-only');
    expect(findingFor(violation as NonNullable<typeof violation>).cause).toContain(
      'allowed: only @ultimat3/cli',
    );
  });

  test('dynamic imports and re-exports are checked too', () => {
    const dynamic = checkBoundaries([
      file('packages/core/src/lazy.ts', "export const load = () => import('@ultimat3/render');"),
    ]);
    expect(dynamic[0]?.to).toBe('render');
    const reexport = checkBoundaries([
      file('packages/core/src/index.ts', "export { render } from '@ultimat3/render';"),
    ]);
    expect(reexport[0]?.to).toBe('render');
  });

  test('a package importing its own subpath is not a violation', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/index.ts', "import { x } from '@ultimat3/cli/templates';"),
      ]),
    ).toEqual([]);
  });

  test('files outside packages/*/src are not subject to the table', () => {
    expect(packageOf('scripts/verify.ts')).toBeUndefined();
    expect(packageOf('packages/cli/src/bin.ts')).toBe('cli');
    expect(scopedName('@ultimat3/http')).toBe('http');
    expect(scopedName('node:fs')).toBeUndefined();
  });

  test('the table itself agrees with the contract', () => {
    expect(tierOf('core')).toBe(0);
    expect(tierOf('cli')).toBe(5);
    expect(checkTier('cli', 'core').allowed).toBe(true);
    expect(checkTier('core', 'cli').allowed).toBe(false);
    expect(checkTier('ui', 'admin').allowed).toBe(false);
  });
});
