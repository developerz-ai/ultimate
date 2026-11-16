// The failure cases first — `node:` and bare builtin names, any quote — then what must never be
// one: a relative or package module, prose, and a test that spells the bad shape as a string.
// Every input is built by hand: a test that edits a real test file to prove the rule races the gate.

import { describe, expect, test } from 'bun:test';
import {
  checkMockBuiltins,
  type MockBuiltinGap,
  mockBuiltinFindingFor,
  scanMockBuiltins,
} from './test-mock-builtin';

const PATH = 'packages/x/src/a.test.ts';
const scan = (...lines: string[]) => scanMockBuiltins(PATH, lines.join('\n'));

describe('scanMockBuiltins', () => {
  test('a mock of a node builtin is reported, by its line and the module it replaces', () => {
    const found = scan(
      "mock.module('node:fs', () => ({ existsSync: () => true }));",
      'await mock.module("child_process", () => ({}));',
      'mock.module(`node:fs/promises`, () => ({}));',
      'mock.module(',
      "  'os',",
      '  () => ({}),',
      ');',
    );
    expect(found.map((site) => [site.line, site.module])).toEqual([
      [1, 'node:fs'],
      [2, 'child_process'],
      [3, 'node:fs/promises'],
      [4, 'os'],
    ]);
  });

  test('a relative module, a package, prose and a string are not a builtin mock', () => {
    expect(
      scan(
        "mock.module('./run', () => ({}));",
        "mock.module('@ultimat3/render', () => ({}));",
        "mock.module('puppeteer-core', () => ({}));",
        // Bun's own `builtinModules` lists these; they are not Node's, and the verdict must not
        // move with the runtime's list.
        "mock.module('ws', () => ({}));",
        "mock.module('undici', () => ({}));",
        "mock.module('bun', () => ({}));",
        "// mock.module('node:fs') leaks into the next file",
        `const fixture = "mock.module('node:fs', () => ({}));";`,
      ),
    ).toEqual([]);
  });

  test('only a test file is read: a source file has no `mock`', () => {
    expect(scanMockBuiltins('packages/x/src/a.ts', "mock.module('node:fs', () => ({}));")).toEqual(
      [],
    );
    expect(
      scanMockBuiltins('packages/x/src/a.test.tsx', "mock.module('fs', () => ({}));"),
    ).toHaveLength(1);
  });
});

describe('checkMockBuiltins — the ratchet', () => {
  const file = { path: PATH, text: "mock.module('node:fs', () => ({}));" };

  test('over its pin is an instruction that names the site and the alternative', () => {
    const [gap] = checkMockBuiltins({ files: [file], pins: {} });
    expect(gap?.kind).toBe('over');
    const finding = mockBuiltinFindingFor(gap as MockBuiltinGap);
    expect(finding.code).toBe('X_TEST_MOCK_BUILTIN');
    expect(finding.cause).toContain(`${PATH}:1 node:fs`);
    expect(finding.fix).toContain('spyOn');
  });

  test('a pin above the tree is stale, and an empty corpus is unscanned', () => {
    const [stale] = checkMockBuiltins({ files: [file], pins: { x: 3 } });
    expect(stale?.kind).toBe('stale');
    expect(mockBuiltinFindingFor(stale as MockBuiltinGap).fix).toBe(
      'bun run scripts/test-mock-builtin.ts --unpin x',
    );
    expect(checkMockBuiltins({ files: [], pins: {} })[0]?.kind).toBe('unscanned');
  });
});
