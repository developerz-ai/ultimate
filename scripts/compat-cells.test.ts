// `compat-cells.ts`: the matrix `compat.yml` declares, read into cells and parts — and refused,
// with the file to edit, when a cell or part is malformed, unknown or repeated. Reads the REAL
// workflow once, so the parse is pinned against the file CI runs.

import { describe, expect, test } from 'bun:test';
import { COMPAT_WORKFLOW, cellOf, partOf, readCompatMatrix } from './compat-cells';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const yaml = (cells: string, parts: string): string =>
  `jobs:\n  cell:\n    strategy:\n      matrix:\n        cell:\n${cells}\n        part:\n${parts}\n`;
const CELL = '          - { id: bun-latest, axis: bun, version: latest, support: supported }';
const PART =
  '          - { name: unit-1, only: unit, shard: 1/3, services: postgres, urls: TEST_DATABASE_URL }';

const refusal = (text: string): string => {
  try {
    readCompatMatrix(text);
  } catch (cause) {
    if (cause instanceof ScriptError) return `${cause.code}: ${cause.cause}`;
    throw cause;
  }
  return expect.unreachable('the matrix was read');
};

describe('unit · compat cells · the matrix', () => {
  test('a cell and a part, read as typed', () => {
    const matrix = readCompatMatrix(yaml(CELL, PART));
    expect(matrix.cells).toEqual([
      { id: 'bun-latest', axis: 'bun', version: 'latest', support: 'supported' },
    ]);
    expect(matrix.parts).toEqual([
      {
        name: 'unit-1',
        only: 'unit',
        shard: '1/3',
        services: ['postgres'],
        urls: ['TEST_DATABASE_URL'],
      },
    ]);
  });

  test('an unknown axis, a bad support and a non-gate step are refused by name', () => {
    expect(refusal(yaml(CELL.replace('axis: bun', 'axis: node'), PART))).toContain('bun-latest');
    expect(refusal(yaml(CELL.replace('supported', 'maybe'), PART))).toContain('support');
    expect(refusal(yaml(CELL, PART.replace('only: unit', 'only: lint')))).toContain('unit-1');
  });

  test('a repeated cell id is refused: one issue title per cell', () => {
    expect(refusal(yaml(`${CELL}\n${CELL}`, PART))).toContain('X_COMPAT_UNREADABLE');
  });

  test('no matrix at all is unreadable, never zero cells', () => {
    expect(refusal('jobs: {}')).toContain(COMPAT_WORKFLOW);
  });

  test('a cell or part not in the matrix is a bad flag naming the ones that are', () => {
    const matrix = readCompatMatrix(yaml(CELL, PART));
    expect(cellOf(matrix, 'bun-latest').axis).toBe('bun');
    expect(() => cellOf(matrix, 'bun-nightly')).toThrow('bun-latest');
    expect(() => partOf(matrix, 'unit-9')).toThrow('unit-1');
  });

  test('each bad flag fix names the flag that was wrong, with a real value in it', () => {
    const matrix = readCompatMatrix(yaml(CELL, PART));
    const fixOf = (thrown: () => unknown): string => {
      try {
        thrown();
      } catch (error) {
        return (error as { fix?: string }).fix ?? '';
      }
      return expect.unreachable('the lookup did not refuse');
    };
    expect(fixOf(() => cellOf(matrix, 'bun-nightly'))).toStartWith(
      'bun run scripts/compat.ts run --cell bun-latest --part <part> --json',
    );
    expect(fixOf(() => partOf(matrix, 'unit-9'))).toStartWith(
      'bun run scripts/compat.ts run --cell <cell> --part unit-1 --json',
    );
  });
});

describe('unit · compat cells · the real workflow', () => {
  test('six cells over three axes, five parts over unit and live', async () => {
    const text = await Bun.file(`${repoRoot()}/${COMPAT_WORKFLOW}`).text();
    const matrix = readCompatMatrix(text);
    expect(matrix.cells.map((cell) => cell.id)).toEqual([
      'bun-latest',
      'bun-canary',
      'postgres-16',
      'postgres-17',
      'postgres-18',
      'solid-1',
    ]);
    expect(matrix.parts.map((part) => `${part.only} ${part.shard}`)).toEqual([
      'unit 1/3',
      'unit 2/3',
      'unit 3/3',
      'live 1/2',
      'live 2/2',
    ]);
  });
});
