// The enforcement half of `scripts/flight-copies.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a fourth backoff curve or an uninjected roll
// fails `bun run verify` with no extra wiring. The real repo is asserted NON-VACUOUSLY — a scanner
// that read nothing reports "no copies", which is the answer a clean repo gives too.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './flight-copies';
import {
  BACKOFF_MODULE,
  checkFlightCopies,
  flightCopyFindings,
  readSources,
} from './flight-copies';
import { repoRoot } from './lib/run';

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
