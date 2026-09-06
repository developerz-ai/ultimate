// The enforcement half of `scripts/flight-copies.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a fourth backoff curve or an uninjected roll
// fails `bun run verify` with no extra wiring. The real repo is asserted NON-VACUOUSLY — a scanner
// that read nothing reports "no copies", which is the answer a clean repo gives too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SourceFile } from './flight-copies';
import {
  BACKOFF_MODULE,
  checkFlightCopies,
  flightCopyFindings,
  flightCopyResult,
  readSources,
} from './flight-copies';
import { render } from './lib/log';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Every test below scans the whole tree, so the budget is the file's default rather than a third
// argument per test — see `REPO_SCAN_TIMEOUT_MS`. This file ran on Bun's 5000ms default until
// 2026-08-27 and went red on a runtime 1.3x slower, which is less than one noisy CI runner.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();

const file = (at: string, text: string): readonly SourceFile[] => [{ at, text }];
const codes = (files: readonly SourceFile[]): readonly string[] =>
  checkFlightCopies(files).map((one) => one.code);

describe('a second curve is recognised by shape, never by name', () => {
  test('refuses a clamped exponent under an innocent name', () => {
    const source =
      'export const spread = (a: number, b: number, m: number, r: () => number) =>\n  Math.min(b * 2 ** a, m) * r();\n';
    expect(codes(file('packages/x/src/spread.ts', source))).toEqual(['X_FLIGHT_SECOND_CURVE']);
  });

  test('refuses a curve with NO jitter at all — a curve is a curve', () => {
    const source =
      'export const grow = (a: number, b: number, cap: number) => Math.min(b * 3 ** (a - 1), cap);\n';
    expect(codes(file('packages/x/src/grow.ts', source))).toEqual(['X_FLIGHT_SECOND_CURVE']);
  });

  test('the one module that may declare it is exempt', () => {
    const source =
      'export const d = (a: number, b: number, m: number) => Math.min(b * 2 ** a, m);\n';
    expect(codes(file(BACKOFF_MODULE, source))).toEqual([]);
  });

  test('an exponent far from a clamp is arithmetic, not a curve', () => {
    const source = `export const area = (r: number) => r ** 2;\n${'// filler\n'.repeat(40)}export const cap = (n: number) => Math.min(n, 10);\n`;
    expect(codes(file('packages/x/src/area.ts', source))).toEqual([]);
  });

  test('a curve written inside a comment is prose, not code', () => {
    const source = '// was: Math.min(base * 2 ** attempt, max)\nexport const x = 1;\n';
    expect(codes(file('packages/x/src/note.ts', source))).toEqual([]);
  });
});

describe('an uninjected roll', () => {
  test('refuses a direct Math.random() call', () => {
    const source = 'export const j = (n: number) => Math.round(n * Math.random());\n';
    expect(codes(file('packages/x/src/j.ts', source))).toEqual(['X_FLIGHT_RANDOM_UNINJECTED']);
  });

  test('allows Math.random as an injectable DEFAULT — a reference, not a call', () => {
    const source =
      'export const j = (n: number, random: () => number = Math.random) => n * random();\n';
    expect(codes(file('packages/x/src/j.ts', source))).toEqual([]);
  });

  test('a Math.random() inside a string literal is data, not a call', () => {
    const source = 'export const hint = "do not use Math.random() here";\n';
    expect(codes(file('packages/x/src/hint.ts', source))).toEqual([]);
  });

  test('reports every call site, not just the first', () => {
    const source = 'export const a = () => Math.random();\nexport const b = () => Math.random();\n';
    expect(codes(file('packages/x/src/two.ts', source))).toEqual([
      'X_FLIGHT_RANDOM_UNINJECTED',
      'X_FLIGHT_RANDOM_UNINJECTED',
    ]);
  });
});

describe('this repository', () => {
  test('computes a retry delay in exactly one place', async () => {
    expect(await flightCopyFindings(ROOT)).toEqual([]);
  });

  test('and the scan really walked shipped source, skipping tests', async () => {
    const files = await readSources(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((one) => one.at.endsWith('.test.ts'))).toBe(false);
    expect(files.some((one) => one.at === BACKOFF_MODULE)).toBe(true);
  });
});

// Finding 7, 2026-09-06: the shape test demanded the `**` operator and `Math.min`, so the two
// other spellings of exactly the same curve read green — which is the failure this file's own
// header names, a rule keyed on one spelling reading past the copy that uses another.
describe('the same curve under another spelling', () => {
  test('Math.pow is the exponent operator with a name in front', () => {
    const source =
      'export const wait = (a: number, b: number, m: number) => Math.min(b * Math.pow(2, a), m);\n';
    expect(codes(file('packages/x/src/wait.ts', source))).toEqual(['X_FLIGHT_SECOND_CURVE']);
  });

  test('a TERNARY clamp is Math.min written out', () => {
    const source =
      'export const wait = (a: number, b: number, m: number) => {\n  const raw = b * 2 ** a;\n  return raw > m ? m : raw;\n};\n';
    expect(codes(file('packages/x/src/wait.ts', source))).toEqual(['X_FLIGHT_SECOND_CURVE']);
  });

  test('and the ternary clamp catches Math.pow too', () => {
    const source =
      'export const wait = (a: number, b: number, m: number) => {\n  const raw = b * Math.pow(2, a);\n  return raw < m ? raw : m;\n};\n';
    expect(codes(file('packages/x/src/wait.ts', source))).toEqual(['X_FLIGHT_SECOND_CURVE']);
  });

  test('but a ternary with no exponent near it is an ordinary choice', () => {
    const source = 'export const pick = (a: number, b: number) => (a > b ? b : a);\n';
    expect(codes(file('packages/x/src/pick.ts', source))).toEqual([]);
  });
});

describe('a die a test cannot control', () => {
  // A curve rolling `crypto.getRandomValues` evaded the rule outright: it is every bit as
  // unpinnable as `Math.random()`, and the die half read only the latter.
  const CURVE = 'const raw = Math.min(base * 2 ** attempt, cap);\n';

  test('crypto.getRandomValues beside a curve is unpinnable in exactly the same way', () => {
    const source = `${CURVE}export const j = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;\n`;
    expect(codes(file('packages/x/src/jitter.ts', source))).toEqual([
      'X_FLIGHT_RANDOM_UNINJECTED',
      'X_FLIGHT_SECOND_CURVE',
    ]);
  });

  test('the globalThis.crypto spelling too — the receiver is not what is matched', () => {
    const source = `${CURVE}export const j = (): number => globalThis.crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;\n`;
    expect(codes(file('packages/x/src/jitter.ts', source))).toEqual([
      'X_FLIGHT_RANDOM_UNINJECTED',
      'X_FLIGHT_SECOND_CURVE',
    ]);
  });

  // The five real sites — `auth/tokens.ts:17`, `core/ids.ts:29`, `core/secrets.ts:84,175`,
  // `realtime/pg-auth.ts:146` — are a token, an id, an encryption key and an IV. For those this
  // rule's own `fix:` is not noise but WRONG advice: a `random: () => number` seam on a key
  // generator is a caller-supplied predictable CSPRNG, which is the vulnerability.
  test('but a CSPRNG with no curve near it is key material, and is never reported', () => {
    const source =
      'export const token = (): string => {\n  const bytes = new Uint8Array(32);\n  crypto.getRandomValues(bytes);\n  return encodeHex(bytes);\n};\n';
    expect(codes(file('packages/auth/src/tokens.ts', source))).toEqual([]);
  });
});

describe('the clamp is a CAP, and the branches have to be the operands', () => {
  // Both measured against the real tree: a rule spelled "a comparison, a `?` and a `:`" reports
  // the sRGB gamma curve, and one accepting `Math.max` reports a decimal rescale.
  test('the sRGB gamma ternary beside a ** is not a clamp', () => {
    const source =
      'export const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);\n';
    expect(codes(file('packages/ui/src/tokens/contrast.ts', source))).toEqual([]);
  });

  test('Math.max is a FLOOR, not a cap', () => {
    const source =
      'export const scale = (a: number, b: number) => Math.max(a, b) * 10n ** BigInt(a);\n';
    expect(codes(file('packages/entity/src/aggregate.ts', source))).toEqual([]);
  });
});

// Finding 8, 2026-09-06: `report()` was given `lines:` and no `findings:`, and `render()` in
// --json mode reads `findings` alone — so a red run published `findings: []`.
describe('--json carries the refusals', () => {
  test('a finding reaches the document rather than an empty array', () => {
    const files = file(
      'packages/x/src/j.ts',
      'export const j = (n: number) => Math.round(n * Math.random());\n',
    );
    const document = JSON.parse(render(flightCopyResult(files), true)) as {
      readonly findings: readonly { readonly code: string }[];
    };
    expect(document.findings.map((one) => one.code)).toEqual(['X_FLIGHT_RANDOM_UNINJECTED']);
  });
});
