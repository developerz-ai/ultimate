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
    if (violation === undefined) throw new Error('expected a violation');
    const finding = findingFor(violation);
    expect(finding.code).toBe('X_BOUNDARY_VIOLATION');
    expect(finding.cause).toContain('http (tier 2) imports @ultimat3/query (tier 3)');
    expect(finding.cause).toContain('allowed tiers: 0-1');
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
    if (violation === undefined) throw new Error('expected a violation');
    expect(violation.reason).toBe('unknown-package');
    expect(findingFor(violation).fix).toContain('scripts/lib/tiers.ts');
  });

  test('type-only imports do not count: they vanish at runtime', () => {
    expect(
      checkBoundaries([
        file('packages/core/src/types.ts', "import type { Route } from '@ultimat3/render';"),
      ]),
    ).toEqual([]);
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
