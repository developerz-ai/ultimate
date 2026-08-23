// The enforcement half of `scripts/dead-docs-host.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so an `ultimate.dev` URL re-entering shipped source
// fails `bun run verify` with no extra wiring.

import { describe, expect, test } from 'bun:test';
import { checkDeadHost, deadHostFindingFor, deadHostGaps, scanDeadHost } from './dead-docs-host';
import { DEAD_HOST_PINS } from './lib/dead-docs-host-pins';
import { repoRoot } from './lib/run';

const lines = (source: string): readonly number[] =>
  scanDeadHost('packages/x/src/errors.ts', source).map((site) => site.line);

describe('a URL the process can emit', () => {
  test('a docs: line is reported, with the line number', () => {
    expect(lines("const e = {\n  docs: 'https://ultimate.dev/errors/X_A',\n};")).toEqual([2]);
  });

  test('a template literal builds one too — that is what docsFor(code) was', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    expect(lines('const d = (c) => `https://ultimate.dev/errors/${c}`;')).toEqual([1]);
  });

  test('the finding names ERROR_DOCS_URL rather than a second URL to paste', () => {
    const gaps = checkDeadHost({
      files: [
        { path: 'packages/x/src/errors.ts', source: "const d = 'https://ultimate.dev/errors/A';" },
      ],
      pins: {},
    });
    const finding = deadHostFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_DEAD_DOCS_HOST');
    expect(finding.at).toBe('packages/x/src/errors.ts:1');
    expect(finding.fix).toContain('ERROR_DOCS_URL');
    expect(finding.fix).not.toContain('ultimate.dev');
  });
});

describe('what the rule stays silent about', () => {
  /**
   * Twelve files in this tree name the host in prose as the thing that was REMOVED —
   * `packages/core/src/error-codes.ts:26` and `packages/ai/src/errors.ts:71` set that precedent.
   * A comment cannot answer 404.
   */
  test('a comment naming the host as the thing that went is not a link', () => {
    expect(
      lines('// The `https://ultimate.dev/errors/<code>` links this file built answered 404'),
    ).toEqual([]);
    expect(
      lines(' * declaring a target that does not exist: https://ultimate.dev/errors/<code>'),
    ).toEqual([]);
  });

  /**
   * The false positive an unescaped dot produces, and the reason `DEAD_HOST` is a constant: this
   * exact string is a fixture value in this tree, and `/ultimate.dev/` matches it because `.`
   * matches `-`.
   */
  test("'ultimate-dev-signing-secret' is not the host", () => {
    expect(lines("const s = 'ultimate-dev-signing-secret';")).toEqual([]);
  });

  test('a test file is a test, and its assertions quote what the code used to emit', () => {
    expect(
      checkDeadHost({
        files: [
          {
            path: 'packages/x/src/errors.test.ts',
            source: "expect(e.docs).toBe('https://ultimate.dev/errors/A');",
          },
        ],
        pins: {},
      }),
    ).toEqual([]);
  });
});

describe('the ratchet', () => {
  test('a pin above what the tree holds is stale, with the command that lowers it', () => {
    const gaps = checkDeadHost({
      files: [{ path: 'packages/x/src/a.ts', source: 'const a = 1;' }],
      pins: { x: 2 },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    expect(deadHostFindingFor(gaps[0] as never).code).toBe('X_DEAD_DOCS_HOST_PIN_STALE');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    expect(deadHostFindingFor(checkDeadHost({ files: [], pins: {} })[0] as never).code).toBe(
      'X_DEAD_DOCS_HOST_UNSCANNED',
    );
  });

  /** Zero on day one, so the rule enforces outright rather than ratcheting down. */
  test('the pin table is empty', () => {
    expect(Object.keys(DEAD_HOST_PINS)).toEqual([]);
  });

  test('and this tree holds no ultimate.dev URL in any shipped string', async () => {
    expect(await deadHostGaps(repoRoot())).toEqual([]);
  });
});
