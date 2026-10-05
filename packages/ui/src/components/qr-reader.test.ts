// The independent reader is only worth something if it can say NO. Each case damages one part of a
// symbol `encodeQr` drew correctly and asserts the reader names that part — so a reader that
// waved everything through would fail here before it could vouch for the encoder.

import { describe, expect, test } from 'bun:test';
import { applyMask, encodeQr, formatInfoBits } from './qr-matrix';
import { formatCells, isFunctionModule, readQr, syndromesZero } from './qr-reader-fixture';

/** A mutable copy of a symbol, with one module flipped per `[row, col]`. */
const flipped = (text: string, cells: readonly (readonly [number, number])[]): boolean[][] => {
  const grid = encodeQr(text).modules.map((row) => [...row]);
  for (const [row, col] of cells) {
    const line = grid[row];
    if (line !== undefined) line[col] = !line[col];
  }
  return grid;
};

describe('readQr refuses what is not a valid symbol', () => {
  test('a damaged finder pattern is named', () => {
    expect(readQr(flipped('hello world', [[3, 3]])).layoutFaults).toContain('finder@3,3');
  });

  test('a damaged timing pattern is named', () => {
    expect(readQr(flipped('hello world', [[6, 10]])).layoutFaults).toContain('timing@6,10');
  });

  test('a damaged alignment pattern is named (versions 2 and 3 carry one)', () => {
    const size = encodeQr('https://dev.ai/abcd1').size;
    const centre = size - 7;
    const reading = readQr(flipped('https://dev.ai/abcd1', [[centre, centre]]));
    expect(reading.layoutFaults).toContain(`alignment@${centre},${centre}`);
  });

  test('a cleared dark module is named', () => {
    const size = encodeQr('A').size;
    expect(readQr(flipped('A', [[size - 8, 8]])).layoutFaults).toContain(
      `dark-module@${size - 8},8`,
    );
  });

  test('two format copies that disagree are named, and an unknown format reads nothing', () => {
    const size = encodeQr('A').size;
    const reading = readQr(flipped('A', [[8, size - 1]]));
    expect(reading.layoutFaults).toContain('format-copies-differ');
    const both = readQr(
      flipped('A', [
        [8, 0],
        [size - 1, 8],
      ]),
    );
    expect(both.layoutFaults).toContain('format-not-level-m');
    expect(both.text).toBe('');
  });

  test('data corrupted past what was checked fails Reed-Solomon and reads no text', () => {
    const size = encodeQr('hello world').size;
    // The bottom-right corner is the first data written: flip a block of it.
    const cells: [number, number][] = [];
    for (let row = size - 4; row < size; row++) cells.push([row, size - 1], [row, size - 2]);
    const reading = readQr(flipped('hello world', cells));
    expect(reading.layoutFaults).toContain('reed-solomon');
    expect(reading.text).toBe('');
  });
});

describe('syndromesZero', () => {
  test('is true for a codeword block the encoder built, false once any word changes', () => {
    const { codewords } = readQr(encodeQr('A').modules);
    expect(syndromesZero(codewords, 10)).toBe(true);
    const damaged = [...codewords];
    damaged[0] = (damaged[0] ?? 0) ^ 1;
    expect(syndromesZero(damaged, 10)).toBe(false);
  });
});

/**
 * The same symbol under mask `to`: every data module re-masked, both format copies rewritten. The
 * encoder picks ONE mask per text by penalty, so without this the reader's other mask rules would
 * be checked by no symbol at all — and a wrong one would misread exactly the texts that need it.
 */
function remasked(text: string, to: number): boolean[][] {
  const grid = encodeQr(text).modules.map((row) => [...row]);
  const from = readQr(grid).mask;
  const size = grid.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (isFunctionModule(size, row, col)) continue;
      if (applyMask(row, col, from) !== applyMask(row, col, to)) {
        const line = grid[row] as boolean[];
        line[col] = !line[col];
      }
    }
  }
  const bits = formatInfoBits(to);
  for (const cells of formatCells(size)) {
    cells.forEach(([row, col], index) => {
      (grid[row] as boolean[])[col] = ((bits >>> (14 - index)) & 1) === 1;
    });
  }
  return grid;
}

describe('readQr reads every one of the eight masks', () => {
  for (const text of ['hello world', 'https://developerz.ai/a1b2c3']) {
    for (let mask = 0; mask < 8; mask++) {
      test(`${JSON.stringify(text)} under mask ${mask}`, () => {
        const reading = readQr(remasked(text, mask));
        expect(reading.mask).toBe(mask);
        expect(reading.layoutFaults).toEqual([]);
        expect(reading.text).toBe(text);
      });
    }
  }
});
