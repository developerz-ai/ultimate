// `compat-part.ts`: one gate part on one cell — the exact `scripts/verify.ts` argv a `ci.yml` part
// runs, read back into the document the filing job judges: green, red with its failing tests, or
// red because the gate printed no document at all. Over an injected spawn.

import { describe, expect, test } from 'bun:test';
import type { CompatCell, CompatPart } from './compat-cells';
import { rerunOf, runPart } from './compat-part';
import type { RunResult } from './lib/run';

const cell = (axis: CompatCell['axis'], version: string): CompatCell => ({
  id: `${axis}-${version}`,
  axis,
  version,
  support: 'supported',
});
const PART: CompatPart = {
  name: 'unit-2',
  only: 'unit',
  shard: '2/3',
  services: ['postgres'],
  urls: ['TEST_DATABASE_URL'],
};

const result = (output: string, code: number): RunResult => ({
  command: [],
  code,
  ok: code === 0,
  output,
  durationMs: 1,
  timedOut: false,
});

const RED = JSON.stringify({
  ok: false,
  steps: [
    {
      name: 'unit',
      ok: false,
      output: 'packages/a/src/b.test.ts:\nExpected: 2\n(fail) b > adds [3ms]',
      findings: [{ code: 'X_TESTS_FAILED', cause: '1 failed', fix: 'bun test ./x' }],
    },
  ],
});

describe('unit · compat part · run', () => {
  test('the gate’s own step, on the part’s shard', async () => {
    const asked: string[] = [];
    const runner = async (command: readonly string[]): Promise<RunResult> => {
      asked.push(command.join(' '));
      return result(JSON.stringify({ ok: true, steps: [{ name: 'unit', ok: true }] }), 0);
    };
    const doc = await runPart({ root: '.', cell: cell('bun', 'canary'), part: PART, runner });
    expect(asked).toEqual(['bun run scripts/verify.ts --only unit --shard 2/3 --json']);
    expect(doc).toMatchObject({ cell: 'bun-canary', part: 'unit-2', attempt: 1, ok: true });
    expect(doc.bun).toBe(`${Bun.version} (${Bun.revision})`);
  });

  test('a red part carries each failing test and the step’s findings', async () => {
    const runner = async (): Promise<RunResult> => result(RED, 1);
    const doc = await runPart({ root: '.', cell: cell('solid', '1'), part: PART, runner });
    expect(doc.ok).toBe(false);
    expect(doc.failures).toEqual([
      { file: 'packages/a/src/b.test.ts', test: 'b > adds', excerpt: 'Expected: 2' },
    ]);
    expect(doc.findings.map((one) => one.code)).toEqual(['X_TESTS_FAILED']);
  });

  test('a document that says green under a red exit is red: the exit is the verdict too', async () => {
    const runner = async (): Promise<RunResult> => result(JSON.stringify({ ok: true }), 1);
    expect((await runPart({ root: '.', cell: cell('bun', 'latest'), part: PART, runner })).ok).toBe(
      false,
    );
  });

  test('no document at all is red and quotes the tail of what was printed', async () => {
    const runner = async (): Promise<RunResult> => result('Segmentation fault', 139);
    const doc = await runPart({ root: '.', cell: cell('bun', 'canary'), part: PART, runner });
    expect(doc.ok).toBe(false);
    expect(doc.findings.map((one) => one.code)).toEqual(['X_COMPAT_UNREADABLE']);
    expect(doc.tail).toContain('Segmentation fault');
  });
});

describe('unit · compat part · the replay line', () => {
  test('a Postgres cell replays on its override; a live part loads the service URLs', () => {
    const live = { ...PART, name: 'live-1', only: 'live' as const, shard: '1/2' };
    const line = rerunOf(cell('postgres', '18'), live);
    expect(line).toContain('compat.ts prepare --cell postgres-18 --compose-out');
    expect(line).toContain('-f docker/docker-compose.test.yml -f');
    expect(line).toContain('. docker/test-services.env');
    expect(line).toEndWith('bun run scripts/verify.ts --only live --shard 1/2');
  });

  test('every part loads the service URLs, a unit part too: compat.yml exports them for both', () => {
    for (const axis of ['bun', 'solid', 'postgres'] as const) {
      const line = rerunOf(cell(axis, axis === 'postgres' ? '18' : '1'), PART);
      expect(line).toContain(
        'set -a; . docker/test-services.env; set +a; bun run scripts/verify.ts --only unit',
      );
      // The URLs point at services that run: a replay starts them before it reads them.
      expect(line).toContain('-f docker/docker-compose.test.yml');
      expect(line).toContain('up -d --wait');
    }
  });

  test('a Bun cell names the channel to install; a Solid cell prepares first', () => {
    expect(rerunOf(cell('bun', 'canary'), PART)).toStartWith('bun upgrade --canary && ');
    expect(rerunOf(cell('solid', '1'), PART)).toStartWith(
      'bun run scripts/compat.ts prepare --cell solid-1 && ',
    );
  });
});
