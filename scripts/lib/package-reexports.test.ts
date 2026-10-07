// The rule over the parser: a value ANY `@ultimat3/*` package exports, published again by another
// package — core's own re-exports of schema included — with the fix aimed at the declaring
// package, a package's own subpath left alone, and every exemption a real value with its argument.

import { describe, expect, test } from 'bun:test';
import { entryFor } from './package-entries';
import {
  PACKAGE_REEXPORT_EXEMPT,
  packageReexportKeys,
  packageReexportViolations,
} from './package-reexports';

const at = 'packages/x/src/index.ts';
const violations = (text: string, path = at) => packageReexportViolations({ at: path, text });

describe('every package is a home, not only core', () => {
  test('a value of a tier-1 package, re-exported by another, is a finding', () => {
    expect(
      violations("import { moneyScale } from '@ultimat3/money';\nexport { moneyScale };"),
    ).toHaveLength(1);
  });

  test("core re-exporting schema's value is a finding: core is a package like any other", () => {
    const [one] = violations(
      "export { formatIssues } from '@ultimat3/schema';",
      'packages/core/src/x.ts',
    );
    expect(one?.fix).toContain("import { formatIssues } from '@ultimat3/schema'");
  });

  // `!src/**/*-fixture.ts` in every manifest's `files`, and `package-shape` refuses an entry that
  // reaches one: a fixture is never published, so it is no import path at all.
  test('a test fixture is no import path, so its re-export is not one either', () => {
    const text = "import { useQuery } from '@ultimat3/realtime';\nexport const probe = useQuery;";
    expect(violations(text, 'packages/cli/src/probe-fixture.ts')).toEqual([]);
    expect(violations(text, 'packages/cli/src/probe-fixture-real.ts')).toHaveLength(1);
  });

  test("a package's own subpath is not another package", () => {
    const text = "export { useQuery } from '@ultimat3/realtime';";
    expect(violations(text, 'packages/realtime/src/boot.ts')).toEqual([]);
    expect(violations(text)).toHaveLength(1);
  });
});

describe('the violation', () => {
  test('names the file, the line, the value and both halves of the fix', () => {
    const [one] = violations("\nexport { fnv1a as hash } from '@ultimat3/core';");
    expect(one?.code).toBe('X_HELPER_COPY');
    expect(one?.cause).toContain('packages/x/src/index.ts:2');
    expect(one?.cause).toContain('a second fnv1a');
    expect(one?.cause).toContain('as `hash`');
    expect(one?.fix).toContain("import { fnv1a } from '@ultimat3/core'");
    expect(one?.fix).toContain('delete the re-export in packages/x/src/index.ts');
  });

  test('a value published by both core entries is sent to /page, the browser-safe one', () => {
    const [one] = violations("export { IDEMPOTENCY_HEADER } from '@ultimat3/core';");
    expect(entryFor('@ultimat3/core/page')?.values.has('IDEMPOTENCY_HEADER')).toBe(true);
    expect(one?.fix).toContain("import { IDEMPOTENCY_HEADER } from '@ultimat3/core/page'");
  });

  test("a barrel's re-export is traced to the package that declares the value", () => {
    const [one] = violations("export { t } from '@ultimat3/action';");
    expect(one?.fix).toContain("import { t } from '@ultimat3/schema'");
  });
});

describe('the exemptions', () => {
  test('a pinned row is not a finding, and the same value elsewhere still is', () => {
    const text = "export { t } from '@ultimat3/schema';";
    expect(violations(text, 'packages/action/src/index.ts')).toEqual([]);
    expect(violations(text, 'packages/action/src/other.ts')).toHaveLength(1);
    expect(packageReexportKeys({ at: 'packages/action/src/index.ts', text })).toEqual([
      'packages/action/src/index.ts#@ultimat3/schema:t',
    ]);
  });

  test('every row names a real value of its source entry and says why', () => {
    for (const row of PACKAGE_REEXPORT_EXEMPT) {
      expect(entryFor(row.from)?.values.has(row.name)).toBe(true);
      expect(row.why.length).toBeGreaterThan(80);
    }
  });
});
