// The enforcement half of `scripts/declaration-readers-callers.ts`: this file IS the build error.
// The gate's `unit` step runs every `scripts/**/*.test.ts`, so a core export that throws and that
// nothing calls fails `bun run verify`. The real tree is asserted NON-VACUOUSLY: a scan whose
// declaration regex stopped matching reads zero exports and the same green a clean tree does.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  CORE_THROWER_PINS,
  callCount,
  checkThrowers,
  THROWER_PINS_FILE,
  throwerFindingFor,
  throwerInput,
  throwingExports,
} from './declaration-readers-callers';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const file = (path: string, text: string) => ({ path, text });

/** The 24.x shape: a public thrower, its barrel line, its own test — and no caller. */
const TREE = [
  file(
    'packages/core/src/env-example.ts',
    [
      'export function checkEnvExample(schema, text) {',
      '  return { ok: true };',
      '}',
      'export function assertEnvExample(schema, text) {',
      '  const report = checkEnvExample(schema, text);',
      '  if (report.ok) return;',
      '  throw new EnvExampleDriftError({ cause: "", fix: "" });',
      '}',
      'export const renderEnvExample = (schema) => "";',
    ].join('\n'),
  ),
  file(
    'packages/core/src/index.ts',
    "export { assertEnvExample, checkEnvExample } from './env-example';",
  ),
  file(
    'packages/core/src/env-example.test.ts',
    "import { assertEnvExample } from './env-example';\nassertEnvExample({}, '');",
  ),
  file(
    'packages/action/src/index.ts',
    "export { assertEnvExample } from '@ultimat3/core';\nexport { checkEnvExample };",
  ),
];

describe('a throwing core export', () => {
  test('is found by its own throw, and only then', () => {
    expect(throwingExports(TREE).map((found) => found.name)).toEqual(['assertEnvExample']);
    expect(throwingExports(TREE)[0]?.at).toBe('packages/core/src/env-example.ts:4');
  });

  test('with no caller is reported — a barrel line, a re-export and a test are not callers', () => {
    const gaps = checkThrowers({ exports: throwingExports(TREE), callers: TREE, pins: {} });
    expect(gaps).toEqual([
      { kind: 'uncalled', name: 'assertEnvExample', at: 'packages/core/src/env-example.ts:4' },
    ]);
    const finding = throwerFindingFor(gaps[0] ?? expect.unreachable('one gap'));
    expect(finding.code).toBe('X_CORE_THROWER_UNCALLED');
    expect(finding.fix.startsWith(`bun run ${THROWER_PINS_FILE} --json`)).toBe(true);
    expect(finding.fix).toContain('CORE_THROWER_PINS');
  });

  test('with one shipped caller anywhere, an app included, is not', () => {
    const app = file(
      'examples/dummy/apps/web/boot.ts',
      "import { assertEnvExample } from '@ultimat3/core';\nassertEnvExample(env, text);",
    );
    const [exported] = throwingExports(TREE);
    expect(callCount(exported ?? expect.unreachable('one export'), [...TREE, app])).toBe(1);
    expect(
      checkThrowers({ exports: throwingExports(TREE), callers: [...TREE, app], pins: {} }),
    ).toEqual([]);
  });

  test('a mention inside a string or comment is no caller — the corpus is masked', () => {
    // What `maskLiterals` leaves of `fix: 'assertEnvExample(schema, text)'`: blanks, offsets kept.
    const masked = file('packages/cli/src/app-env.ts', "const fix = '                     ';");
    expect(
      checkThrowers({ exports: throwingExports(TREE), callers: [...TREE, masked], pins: {} }),
    ).toHaveLength(1);
  });
});

describe('the pins', () => {
  test('a reasoned pin waives; a blank one waives nothing', () => {
    const exports = throwingExports(TREE);
    expect(
      checkThrowers({ exports, callers: TREE, pins: { assertEnvExample: { reason: 'apps' } } }),
    ).toEqual([]);
    expect(
      checkThrowers({ exports, callers: TREE, pins: { assertEnvExample: { reason: ' ' } } }).map(
        (gap) => gap.kind,
      ),
    ).toEqual(['uncalled']);
  });

  test('a pin for a name that is called, or gone, is stale', () => {
    const gaps = checkThrowers({
      exports: throwingExports(TREE),
      callers: TREE,
      pins: { assertEnvExample: { reason: 'apps' }, resolveSpeculation: { reason: 'cli' } },
    });
    expect(gaps).toEqual([{ kind: 'stale', name: 'resolveSpeculation', reason: 'cli' }]);
    expect(throwerFindingFor(gaps[0] ?? expect.unreachable('one gap')).code).toBe(
      'X_CORE_THROWER_PIN_STALE',
    );
  });

  test('every shipped pin carries a reason', () => {
    for (const [name, pin] of Object.entries(CORE_THROWER_PINS)) {
      expect([name, pin.reason.trim().length > 20]).toEqual([name, true]);
    }
  });
});

describe('nothing scanned', () => {
  test('is refused, never read as clean', () => {
    const gaps = checkThrowers({ exports: [], callers: TREE, pins: {} });
    expect(gaps.map((gap) => throwerFindingFor(gap).code)).toEqual(['X_CORE_THROWERS_UNSCANNED']);
  });
});

describe('this repository', () => {
  test('every throwing core export is called or pinned, and the scan read the tree', async () => {
    const input = await throwerInput(repoRoot());
    expect(input.exports.length).toBeGreaterThan(40);
    expect(input.callers.length).toBeGreaterThan(1000);
    expect(input.exports.map((found) => found.name)).toContain('defineConfig');
    expect(checkThrowers(input).map(throwerFindingFor)).toEqual([]);
  });
});
