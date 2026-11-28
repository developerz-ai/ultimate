import { describe, expect, test } from 'bun:test';
import { decodeImage, encodeImage } from '@ultimat3/core';
import { compareCaptures, padRaster, similarityOf } from './shot-diff';

const solid = (width: number, height: number, rgba: readonly number[]): Uint8Array => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set(rgba, at);
  return encodeImage({ width, height, pixels });
};

describe('compareCaptures', () => {
  test('two identical captures are similarity 1 with nothing changed', async () => {
    const png = solid(4, 3, [10, 20, 30, 255]);
    const result = await compareCaptures(png, png, 0.1);
    expect(result.similarity).toBe(1);
    expect(result.changedPixels).toBe(0);
    expect(result.changedBox).toBeNull();
    expect(decodeImage(result.diffPng).width).toBe(4);
  });

  test('a capture of another colour is similarity 0', async () => {
    const result = await compareCaptures(
      solid(2, 2, [0, 0, 0, 255]),
      solid(2, 2, [255, 255, 255, 255]),
      0.1,
    );
    expect(result.similarity).toBe(0);
    expect(result.changedPixels).toBe(4);
  });

  test('two sizes are compared on the larger canvas: what only one covers counts as changed', async () => {
    const result = await compareCaptures(
      solid(2, 2, [9, 9, 9, 255]),
      solid(2, 4, [9, 9, 9, 255]),
      0.1,
    );
    expect(result.width).toBe(2);
    expect(result.height).toBe(4);
    expect(result.changedPixels).toBe(4);
    expect(result.similarity).toBe(0.5);
  });
});

describe('padRaster', () => {
  test('keeps the pixels it has and fills the rest transparent', () => {
    const raster = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4]) };
    const padded = padRaster(raster, 2, 1);
    expect([...padded.pixels]).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(padRaster(raster, 1, 1)).toBe(raster);
  });
});

describe('similarityOf', () => {
  test('is the unchanged share, four decimals, and 1 for an empty image', () => {
    expect(similarityOf(1, 3, 1)).toBe(0.6667);
    expect(similarityOf(0, 0, 0)).toBe(1);
  });
});
