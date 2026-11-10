// The boot bench's fixture: names that sort the way the scan sorts, modules that transpile and
// form a graph, and the median it reports.

import { describe, expect, test } from 'bun:test';
import { median, moduleName, moduleSource } from './boot-vs-files-shape';

describe('boot-vs-files shape', () => {
  test('a lexical sort of the names is the numeric order', () => {
    const names = [moduleName(10), moduleName(9), moduleName(100)];
    expect([...names].sort()).toEqual([moduleName(9), moduleName(10), moduleName(100)]);
  });

  test('every tenth module imports the one before it, and every module transpiles', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(transpiler.scanImports(moduleSource(10)).map((entry) => entry.path)).toEqual([
      '@ultimat3/entity',
      './mod-00009',
    ]);
    expect(transpiler.scanImports(moduleSource(11)).map((entry) => entry.path)).toEqual([
      '@ultimat3/entity',
    ]);
  });

  test('the median of three is the middle one', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([])).toBe(0);
  });
});
