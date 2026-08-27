// The failure case first, then the two ways this rule could stop being one: a pin above what the
// tree holds (which would let throws back in), and a glob matching nothing (which reads exactly
// like a clean tree). Every case builds its input by hand — a test that edits a real test file to
// prove it can fail is a test that races the gate it guards.

import { describe, expect, test } from 'bun:test';
import {
  type BareErrorGap,
  bareErrorFindingFor,
  checkBareErrors,
  scanBareErrorThrows,
} from './test-bare-error';

const file = (path: string, text: string) => ({ path, text });

describe('scanBareErrorThrows separates the verdict from the input', () => {
  test('a thrown bare Error is the verdict, and is reported', () => {
    const found = scanBareErrorThrows(
      'packages/x/src/a.test.ts',
      "test('x', () => {\n  throw new Error('expected a refusal');\n});\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  // The carve-out #132 said grep could not make. These are the code-under-test's INPUT, and
  // `packages/realtime/CLAUDE.md` blesses them: "the rule governs what this package throws, never
  // what a test hands it." A rule that reported these would ask for a rewrite that changes what the
  // surrounding tests prove.
  test('an Error handed to the subject is the input, and is not reported', () => {
    const inputs = [
      "invalidateTags: () => Promise.reject(new Error('redis is down')),",
      'const payload = await render(new Error("the driver went away"));',
      "const foreign = Object.assign(new Error('denied'), { code: 'X_D', cause: 'c', fix: 'f' });",
      'const held = new Error("kept for later");',
    ];
    for (const line of inputs) {
      expect(scanBareErrorThrows('packages/x/src/a.test.ts', line)).toEqual([]);
    }
  });

  test('a subclass is not a bare Error', () => {
    const source = "throw new UltimateError({ code: 'X_A', cause: 'c', fix: 'f' });";
    expect(scanBareErrorThrows('packages/x/src/a.test.ts', source)).toEqual([]);
  });

  // This file spells the bad shape as a string on purpose, and so does the rule's own fixture set.
  // Without the tokenizer, a checker could never describe what it checks.
  test('the shape written inside a string literal is a fixture, not a throw', () => {
    const source = 'const bad = "throw new Error(\'nope\');";\n';
    expect(scanBareErrorThrows('packages/x/src/a.test.ts', source)).toEqual([]);
  });

  // The defect: a comment quoting the shape in order to EXPLAIN it was counted as committing it.
  // Measured — `packages/auth/src/oauth-profile.test.ts:51` and
  // `packages/entity/src/tenancy.test.ts:43` are two doc comments that each said why a bare throw
  // is wrong, and each cost its package a pin. `dead-docs-host.ts` states the same carve-out for
  // the same reason: naming the banned thing is not doing it.
  test('the shape quoted in a line comment is prose about a throw, not a throw', () => {
    const source = "// a sentinel throw new Error('expected a throw') would be a bare Error\n";
    expect(scanBareErrorThrows('packages/x/src/a.test.ts', source)).toEqual([]);
  });

  test('the shape quoted in a block comment or a JSDoc is prose too', () => {
    const block = "/* throw new Error('nope') is what this used to do */\n";
    const jsdoc = [
      '/**',
      " * A `throw new Error('unreachable')` inside a try/catch lands in its own catch.",
      ' */',
      'const rejection = 1;',
    ].join('\n');
    expect(scanBareErrorThrows('packages/x/src/a.test.ts', block)).toEqual([]);
    expect(scanBareErrorThrows('packages/x/src/a.test.ts', jsdoc)).toEqual([]);
  });

  // THE REGRESSION DIRECTION, and the one that matters: an exemption wider than a comment switches
  // the rule off. The throw sits on the line AFTER a comment that quotes it, so a scanner that
  // blanked one character too many, or gave up on the rest of the line, reports nothing here.
  test('a real throw beside a comment quoting one is still the verdict, at its own line', () => {
    const source = [
      "// never write throw new Error('x') as a verdict — use expect.unreachable",
      "throw new Error('expected a refusal'); // and this one is real",
      '/** and this JSDoc mentions throw new Error() again */',
      "throw new Error('second');",
    ].join('\n');
    const found = scanBareErrorThrows('packages/x/src/a.test.ts', source);
    expect(found.map((site) => site.line)).toEqual([2, 4]);
  });
});

describe('the ratchet', () => {
  const overOne = [
    file('packages/x/src/a.test.ts', "throw new Error('a');\nthrow new Error('b');\n"),
  ];

  test('a package over its pin is a finding that names the first site', () => {
    const gaps = checkBareErrors({ files: overOne, pins: { x: 1 } });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('over');
    expect(gaps[0]?.found).toBe(2);
    const finding = bareErrorFindingFor(gaps[0] as BareErrorGap);
    expect(finding.code).toBe('X_TEST_BARE_ERROR');
    expect(finding.at).toBe('packages/x/src/a.test.ts:1');
    expect(finding.fix).toInclude('expect.unreachable');
  });

  test('a package at its pin is clean', () => {
    expect(checkBareErrors({ files: overOne, pins: { x: 2 } })).toEqual([]);
  });

  // The ratchet's own hygiene: a pin above what the tree holds is a pin that would let throws back
  // in silently, which is the one direction a ratchet may never move.
  test('a pin above what the tree holds is stale, and the fix is the unpin command', () => {
    const gaps = checkBareErrors({ files: overOne, pins: { x: 5 } });
    expect(gaps[0]?.kind).toBe('stale');
    const finding = bareErrorFindingFor(gaps[0] as BareErrorGap);
    expect(finding.code).toBe('X_TEST_BARE_ERROR_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/test-bare-error.ts --unpin x');
  });

  test('a package with no pin may have none', () => {
    const clean = [file('packages/y/src/b.test.ts', "expect.unreachable('nope');\n")];
    expect(checkBareErrors({ files: clean, pins: {} })).toEqual([]);
  });

  // The false green this rule could ship with: no files read reports zero for every package.
  test('reading no file at all is a finding, not a pass', () => {
    const gaps = checkBareErrors({ files: [], pins: { x: 1 } });
    expect(gaps[0]?.kind).toBe('unscanned');
    expect(bareErrorFindingFor(gaps[0] as BareErrorGap).code).toBe('X_TEST_BARE_ERROR_UNSCANNED');
  });
});
