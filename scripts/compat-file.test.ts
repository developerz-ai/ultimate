// `compat-file.ts`: a run's part documents judged per cell — a red or missing part makes the cell's
// one issue, every part green resolves it, a re-run's newer attempt replaces the older — and the
// filing over the shared ledger, so a cell's own green run closes the issue its red run opened.

import { describe, expect, test } from 'bun:test';
import type { CompatMatrix } from './compat-cells';
import { COMPAT_LABEL, fileCompat, judgeCells, titleOf } from './compat-file';
import type { PartDoc } from './compat-part';
import type { RunResult } from './lib/run';

const MATRIX: CompatMatrix = {
  cells: [
    { id: 'bun-canary', axis: 'bun', version: 'canary', support: 'watched' },
    { id: 'postgres-18', axis: 'postgres', version: '18', support: 'supported' },
  ],
  parts: ['unit-1', 'live-1'].map((name) => ({
    name,
    only: name.startsWith('unit') ? ('unit' as const) : ('live' as const),
    shard: '1/2',
    services: ['postgres'],
    urls: ['TEST_DATABASE_URL'],
  })),
};

const doc = (cell: string, part: string, over: Partial<PartDoc> = {}): PartDoc => ({
  cell,
  part,
  attempt: 1,
  ok: true,
  bun: '1.5.0 (abc)',
  failures: [],
  findings: [],
  rerun: `replay ${cell} ${part}`,
  tail: '',
  ...over,
});

const RED = {
  ok: false,
  failures: [{ file: 'packages/a/src/b.test.ts', test: 'b > adds', excerpt: 'Expected: 2' }],
};

describe('unit · compat file · judging the cells', () => {
  test('a cell with a red part files one issue naming the test and its replay', () => {
    const docs = [
      doc('bun-canary', 'unit-1', RED),
      doc('bun-canary', 'live-1'),
      doc('postgres-18', 'unit-1'),
      doc('postgres-18', 'live-1'),
    ];
    const { red, green } = judgeCells(MATRIX, docs, 'https://example.test/run/9');
    expect(red.map((plan) => plan.title)).toEqual(['compat: bun-canary']);
    for (const needle of [
      'https://example.test/run/9',
      '1.5.0 (abc)',
      '| unit-1 | red | 1 |',
      '| live-1 | green | 0 |',
      'packages/a/src/b.test.ts > b > adds',
      'replay bun-canary unit-1',
      'Expected: 2',
    ]) {
      expect(red[0]?.body).toContain(needle);
    }
    expect(green.map((plan) => plan.title)).toEqual(['compat: postgres-18']);
  });

  test('a part that wrote no document is red: its job died before the gate ran', () => {
    const { red, green } = judgeCells(MATRIX, [doc('postgres-18', 'unit-1')], undefined);
    expect(red.map((plan) => plan.title)).toEqual(['compat: bun-canary', 'compat: postgres-18']);
    expect(red[1]?.body).toContain('| live-1 | no document | – |');
    expect(green).toEqual([]);
  });

  test('a re-run’s newer attempt replaces the red one it re-ran', () => {
    const docs = [
      doc('bun-canary', 'unit-1', RED),
      doc('bun-canary', 'unit-1', { attempt: 2 }),
      doc('bun-canary', 'live-1'),
    ];
    const { green } = judgeCells({ ...MATRIX, cells: MATRIX.cells.slice(0, 1) }, docs, undefined);
    expect(green.map((plan) => plan.title)).toEqual(['compat: bun-canary']);
  });

  test('a document for a cell the matrix no longer names is not judged', () => {
    const { red, green } = judgeCells({ ...MATRIX, cells: [] }, [doc('gone', 'unit-1')], undefined);
    expect([red, green]).toEqual([[], []]);
  });

  test('an excerpt carrying a mention stays fenced', () => {
    const excerpt = '````\n@scope/x\n````';
    const docs = [
      doc('bun-canary', 'unit-1', {
        ok: false,
        failures: [{ ...RED.failures[0], excerpt } as PartDoc['failures'][number]],
      }),
    ];
    const [plan] = judgeCells({ ...MATRIX, cells: MATRIX.cells.slice(0, 1) }, docs, undefined).red;
    expect(plan?.body).toContain(`\`\`\`\`\`text\n${excerpt}\n\`\`\`\`\``);
  });
});

const ok = (output = ''): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});

describe('unit · compat file · filing', () => {
  test('the red cell reopens its issue and the green one closes its own, under the compat label', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(args.slice(0, 3).join(' '));
      if (args[1] !== 'list') return ok();
      return ok(
        JSON.stringify([
          { number: 5, title: titleOf('bun-canary'), state: 'CLOSED' },
          { number: 6, title: titleOf('postgres-18'), state: 'OPEN' },
        ]),
      );
    };
    const docs = [
      doc('bun-canary', 'unit-1', RED),
      doc('bun-canary', 'live-1'),
      doc('postgres-18', 'unit-1'),
      doc('postgres-18', 'live-1'),
    ];
    const answer = await fileCompat(MATRIX, docs, '.', undefined, gh);
    expect(answer.findings).toEqual([]);
    expect(asked).toEqual([
      `label create ${COMPAT_LABEL}`,
      `issue list --label`,
      'issue reopen 5',
      'issue close 6',
    ]);
    expect(answer.red).toEqual(['bun-canary']);
  });

  test('a refused gh call is X_COMPAT_FILE_FAILED with the command to retry', async () => {
    const gh = async (args: readonly string[]): Promise<RunResult> =>
      args[1] === 'list' ? { ...ok('HTTP 502'), ok: false, code: 1 } : ok();
    const answer = await fileCompat(MATRIX, [], '.', undefined, gh);
    expect(answer.findings.map((one) => one.code)).toEqual(['X_COMPAT_FILE_FAILED']);
    expect(answer.findings[0]?.fix).toStartWith('gh auth status && bun run scripts/compat.ts file');
  });
});
