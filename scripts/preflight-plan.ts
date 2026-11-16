// What `bun run preflight` runs for a diff, decided purely: the units it touched (each a package
// directory or `scripts`), the cheap ratchets, coverage per touched unit, the serve-graph test when
// a `packages/*/src` file moved — and which findings are this diff's, so a teammate's red in a
// shared checkout is printed beside the verdict and never decides it.

import type { Finding } from './lib/log';

/** The ratchets cheap enough to run on every preflight: seconds each, whole tree. */
export const PREFLIGHT_RATCHETS = [
  'fix-prose',
  'fix-shell-arg',
  'node-imports',
  'secret-compare',
  'proto-index',
  'spawn-timeout',
  'url-pathname',
  'test-bare-error',
  'test-real-sleep',
  'test-slow',
  'factory-names',
  'test-typecheck-gate',
  // Not a ratchet: a test case gone from a directory whose code did not change (`X_TEST_VANISHED`).
  'vanished-tests',
] as const;

export const SERVE_GRAPH_TEST = './packages/cli/src/serve-graph.test.ts';

export interface PreflightStep {
  /** What the verdict line calls it: `fix-prose`, `coverage cli`, `serve-graph`. */
  readonly name: string;
  readonly command: readonly string[];
  /** `bun test` answers no JSON document: its exit code is the whole answer. */
  readonly kind: 'script' | 'test';
  /** The heavy steps run one at a time, after the cheap ones. */
  readonly heavy: boolean;
}

/** The unit a path belongs to: `packages/<unit>/…` for a gated package, `scripts/…`, or none. */
export function unitOfPath(path: string, units: readonly string[]): string | undefined {
  const [top, name] = path.split('/');
  if (top === 'scripts') return units.includes('scripts') ? 'scripts' : undefined;
  if (top === 'packages' && name !== undefined && units.includes(name)) return name;
  return undefined;
}

/** Every unit the diff touched, sorted. */
export const touchedUnits = (changed: readonly string[], units: readonly string[]): string[] =>
  [...new Set(changed.flatMap((path) => unitOfPath(path, units) ?? []))].sort();

/** A `packages/*\/src` file that appeared or vanished: what moves the boot path's module graph. */
export const movedSource = (
  changed: readonly string[],
  added: readonly string[],
  exists: (path: string) => boolean,
): string[] =>
  changed.filter(
    (path) =>
      /^packages\/[^/]+\/src\//.test(path) &&
      !/\.test\.[cm]?tsx?$/.test(path) &&
      (added.includes(path) || !exists(path)),
  );

export function preflightSteps(input: {
  readonly touched: readonly string[];
  readonly moved: readonly string[];
}): readonly PreflightStep[] {
  const ratchets = PREFLIGHT_RATCHETS.map(
    (name): PreflightStep => ({
      name,
      command: ['bun', 'run', `scripts/${name}.ts`, '--json'],
      kind: 'script',
      heavy: name === 'test-typecheck-gate',
    }),
  );
  const coverage = input.touched.map(
    (unit): PreflightStep => ({
      name: `coverage ${unit}`,
      command: ['bun', 'run', 'scripts/coverage-gate.ts', '--package', unit, '--json'],
      kind: 'script',
      heavy: true,
    }),
  );
  const graph: readonly PreflightStep[] =
    input.moved.length === 0
      ? []
      : [
          {
            name: 'serve-graph',
            command: ['bun', 'test', SERVE_GRAPH_TEST],
            kind: 'test',
            heavy: true,
          },
        ];
  return [...ratchets, ...coverage, ...graph];
}

/**
 * A finding is this diff's when it points into a file the diff changed or a unit it touched; a
 * finding with no place to point at is everyone's, so it counts.
 */
export function isOurs(
  finding: Finding,
  touched: readonly string[],
  changed: readonly string[],
): boolean {
  if (finding.at === undefined || finding.at === '') return true;
  const path = finding.at.replace(/:\d+(?::\d+)?$/, '');
  return changed.includes(path) || unitOfPath(path, touched) !== undefined;
}
