// The safety net under running a step's host checks side by side: on a fixture tree with findings
// planted for the rules of all three steps, the parallel run answers what the serial one does —
// check by check, in list order — and the runner itself keeps list order, throws what the serial
// run would throw, and keeps the two fence rules off each other's fixture directory.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { HostCheck } from '@ultimat3/cli';
import { CONFIG_FILES } from './lib/config-leaves';
import {
  allOf,
  atMost,
  COMPILER_THREADS,
  compilerWidth,
  oneAtATime,
  runHostChecks,
} from './lib/host-check-run';
import type { Finding } from './lib/log';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  BOUNDARY_CHECKS,
  ERROR_CHECKS,
  ERROR_REFERENCE,
  HOST_CHECKS,
  MANIFEST_CHECKS,
} from './verify-host-checks';

const finding = (code: string): Finding => ({ code, cause: code, fix: 'bun run verify' });

/** `turns` microtask turns, then done: finishing order set by the test, never by a clock. */
const yieldTurns = async (turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};
const after =
  (turns: number, code: string): HostCheck =>
  async () => {
    await yieldTurns(turns);
    return [finding(code)];
  };

describe('the runner', () => {
  test('answers in list order, whichever check finishes first', async () => {
    const done: string[] = [];
    const tracked =
      (turns: number, code: string): HostCheck =>
      async (root) => {
        const found = await after(turns, code)(root);
        done.push(code);
        return found;
      };
    const checks = [tracked(30, 'A'), tracked(0, 'B'), tracked(15, 'C')];
    const parallel = await runHostChecks(checks, '/', 'parallel');
    expect(done).toEqual(['B', 'C', 'A']);
    expect(parallel.map((one) => one.code)).toEqual(['A', 'B', 'C']);
    expect(parallel).toEqual(await runHostChecks(checks, '/', 'serial'));
  });

  test('runs side by side: every check is started before any has finished', async () => {
    // A barrier no check passes until all three have arrived: one after another, it never opens.
    let arrived = 0;
    let open: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const waits =
      (code: string): HostCheck =>
      async () => {
        arrived += 1;
        if (arrived === 3) open();
        await barrier;
        return [finding(code)];
      };
    const found = await allOf([waits('A'), waits('B'), waits('C')])('/');
    expect(found.map((one) => one.code)).toEqual(['A', 'B', 'C']);
  });

  test('throws what the serial run throws: the first failing check in list order', async () => {
    const fails =
      (turns: number, code: string): HostCheck =>
      async () => {
        await yieldTurns(turns);
        throw finding(code);
      };
    const checks = [after(0, 'A'), fails(30, 'FIRST'), fails(0, 'SECOND')];
    for (const mode of ['serial', 'parallel'] as const) {
      const thrown = await runHostChecks(checks, '/', mode).then(
        () => expect.unreachable('a check threw'),
        (error: unknown) => error,
      );
      expect(thrown).toEqual(finding('FIRST'));
    }
  });

  test('one-at-a-time checks never overlap, run in list order, and keep their places', async () => {
    const shared = oneAtATime();
    const log: string[] = [];
    const exclusive =
      (name: string, turns: number): HostCheck =>
      async () => {
        log.push(`start ${name}`);
        await yieldTurns(turns);
        log.push(`end ${name}`);
        return [finding(name)];
      };
    const found = await runHostChecks(
      [shared(exclusive('readme', 30)), after(0, 'between'), shared(exclusive('wiki', 0))],
      '/',
    );
    expect(log).toEqual(['start readme', 'end readme', 'start wiki', 'end wiki']);
    expect(found.map((one) => one.code)).toEqual(['readme', 'between', 'wiki']);
  });

  test('a pool of two never runs a third, starts in list order, and keeps every place', async () => {
    const pool = atMost(2);
    const log: string[] = [];
    let running = 0;
    let peak = 0;
    const pooled =
      (name: string, turns: number): HostCheck =>
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        log.push(`start ${name}`);
        await yieldTurns(turns);
        running -= 1;
        return [finding(name)];
      };
    const found = await runHostChecks(
      [pool(pooled('a', 30)), pool(pooled('b', 5)), after(0, 'free'), pool(pooled('c', 0))],
      '/',
    );
    expect(peak).toBe(2);
    expect(log).toEqual(['start a', 'start b', 'start c']);
    expect(found.map((one) => one.code)).toEqual(['a', 'b', 'free', 'c']);
  });

  test('a throwing pooled check frees its slot, and the next one still runs', async () => {
    const pool = atMost(1);
    const boom: HostCheck = async () => {
      throw finding('BOOM');
    };
    const thrown = await runHostChecks([pool(boom), pool(after(0, 'next'))], '/').then(
      () => expect.unreachable('the first check threw'),
      (error: unknown) => error,
    );
    expect(thrown).toEqual(finding('BOOM'));
    expect((await pool(after(0, 'later'))('/')).map((one) => one.code)).toEqual(['later']);
  });

  test('one compiler per four CPUs, never none: 4 CPUs run one tsc, 12 run three', () => {
    expect(COMPILER_THREADS).toBe(4);
    expect([1, 3, 4, 7, 8, 12, 16].map((cpus) => compilerWidth(cpus))).toEqual([
      1, 1, 1, 1, 2, 3, 4,
    ]);
    for (const odd of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compilerWidth(odd)).toBe(1);
    }
  });
});

/** One finding planted per rule a fixture can reach, across all three steps. */
const PLANTED: Readonly<Record<string, string>> = {
  // boundaries: the tier table, a keyed hasher, a cipher call, the image contract.
  'packages/core/src/bad.ts':
    "import { dispatch } from '@ultimat3/cli';\nexport const run = dispatch;\n",
  'packages/auth/src/hash.ts':
    "export const h = (key: string) => new Bun.CryptoHasher('sha256', key);\n",
  'packages/auth/src/seal.ts':
    'export const s = (k: CryptoKey, d: Uint8Array) => crypto.subtle.encrypt(ALG, k, d);\n',
  'docker/Dockerfile': [
    'FROM oven/bun:1.3-alpine AS build',
    'RUN bun build --compile --outfile /out/app ./x.ts',
    'FROM gcr.io/distroless/cc-debian13:nonroot AS runtime',
    'COPY --from=build /out/app /app/x',
    'ENTRYPOINT ["/app/x"]',
    '',
  ].join('\n'),
  // errors: an undocumented code, a ghost row, an unsafe render, a bare throw in a test.
  'packages/mail/src/codes.ts': "export const f = { code: 'X_MADE_UP', fix: 'bun run verify' };\n",
  [ERROR_REFERENCE]: '# Error codes\n\n| `X_GHOST` | means |\n',
  'packages/core/src/render.ts': `export function f(value: unknown) {\n  return new E({ cause: \`bad $${'{'}value}\`, fix: 'x' });\n}\n`,
  'packages/core/src/thrown.test.ts': "test('x', () => {\n  throw new Error('bare');\n});\n",
  // manifest: a broken wiki table, a stale chart, an unpublished workspace, an unseen test file.
  'wiki/Bad.md': '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n',
  'packages/core/package.json': '{ "name": "@ultimat3/core", "version": "1.3.0" }\n',
  '.github/workflows/release.yml':
    '      - name: publish tier 0\n        run: npm publish -w @ultimat3/schema\n',
  'docker/helm/Chart.yaml': 'version: 0.0.1\nappVersion: "0.0.1"\n',
  'a.spec.ts': "test('seeded', () => {});\n",
};

/** Each check's own answer, by its index in the list — so a difference names the check. */
async function perCheck(
  checks: readonly HostCheck[],
  root: string,
  mode: 'serial' | 'parallel',
): Promise<readonly (readonly Finding[])[]> {
  const answers: (readonly Finding[])[] = checks.map(() => []);
  const recorded = checks.map(
    (check, index): HostCheck =>
      async (at) => {
        const found = await check(at);
        answers[index] = found;
        return found;
      },
  );
  await runHostChecks(recorded, root, mode);
  return answers;
}

describe('the real host checks, serial and side by side, on one planted tree', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-host-checks-'));
    for (const [path, text] of Object.entries(PLANTED)) await Bun.write(join(root, path), text);
    // `docFixFindings` reads the config leaves whenever a reference page exists: the real ones.
    for (const path of CONFIG_FILES) {
      await Bun.write(join(root, path), Bun.file(join(repoRoot(), path)));
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const STEPS = [
    [
      'boundaries',
      BOUNDARY_CHECKS,
      [
        'X_BOUNDARY_VIOLATION',
        'X_KEYED_HASHER',
        'X_SEAL_CALL_OUTSIDE_CORE',
        'X_IMAGE_LIBC_MISMATCH',
      ],
    ],
    [
      'errors',
      ERROR_CHECKS,
      ['X_ERROR_CODE_UNDOCUMENTED', 'X_ERROR_CODE_UNREGISTERED', 'X_ERROR_RENDER_UNSAFE'],
    ],
    [
      'manifest',
      MANIFEST_CHECKS,
      [
        'X_WIKI_TABLE_MALFORMED',
        'X_CHART_VERSION_STALE',
        'X_PUBLISH_LIST_INCOMPLETE',
        'X_TEST_DISCOVERY_UNSEEN',
      ],
    ],
  ] as const;

  for (const [step, checks, planted] of STEPS) {
    test(
      `${step}: every check answers the same, and every planted finding is in the answer`,
      async () => {
        const serial = await perCheck(checks, root, 'serial');
        const parallel = await perCheck(checks, root, 'parallel');
        expect(parallel).toEqual(serial);
        const codes = serial.flat().map((one) => one.code);
        for (const code of planted) expect(codes).toContain(code);
        // The step as `runVerify` calls it is the same list, concatenated in order.
        const wired = HOST_CHECKS[step];
        if (wired === undefined) return expect.unreachable(`${step} carries host checks`);
        expect(await wired(root)).toEqual(serial.flat());
      },
      REPO_SCAN_TIMEOUT_MS,
    );
  }
});
