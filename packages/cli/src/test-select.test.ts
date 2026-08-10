// Selection, tested away from the command that calls it: which positional is a type, what
// `--sample` refuses, and which files each type claims. One file for the decisions `x test` makes
// before anything runs, so a red line here names a selection bug and never a wiring one.

import { describe, expect, test } from 'bun:test';
import { NoTestFilesError } from './errors';
import type { CommandSpec, ParsedArgs } from './parse';
import { parseArgs } from './parse';
import type { TestFile } from './test-select';
import {
  belongsToType,
  bySizeThenPath,
  missingSelection,
  readSample,
  readType,
  sampleFiles,
} from './test-select';
import { thrownBy } from './thrown-by';

const SPEC: CommandSpec = {
  name: 'test',
  summary: 'fixture',
  usage: 'x test',
  flags: [{ name: 'sample', type: 'string', summary: 'fixture' }],
};

const argsFor = (argv: readonly string[]): ParsedArgs => parseArgs(argv, [SPEC]);

describe('unit · belongsToType', () => {
  test('a typed suffix belongs to its own type and no other', () => {
    expect(belongsToType('a/thing.contract.test.ts', 'contract')).toBe(true);
    expect(belongsToType('a/thing.contract.test.ts', 'live')).toBe(false);
    expect(belongsToType('a/thing.contract.test.ts', 'unit')).toBe(false);
  });

  test('e2e matches both the suffix and the directory form', () => {
    expect(belongsToType('a/thing.e2e.test.ts', 'e2e')).toBe(true);
    expect(belongsToType('e2e/nested/thing.test.ts', 'e2e')).toBe(true);
    expect(belongsToType('e2e/nested/thing.test.ts', 'unit')).toBe(false);
  });

  test('unit is a plain *.test.ts file — none of the five typed suffixes', () => {
    expect(belongsToType('a/thing.test.ts', 'unit')).toBe(true);
    for (const type of ['contract', 'live', 'job', 'e2e', 'eval'] as const) {
      expect(belongsToType('a/thing.test.ts', type)).toBe(false);
    }
  });
});

describe('unit · readType', () => {
  test('no positional means every type', () => {
    expect(readType(undefined)).toBeUndefined();
  });

  test('a real type passes through unchanged', () => {
    expect(readType('contract')).toBe('contract');
  });

  test('an unknown type throws X_CLI_BAD_FLAG and suggests the nearest real type', () => {
    const failure = thrownBy(() => readType('contrat'));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x test contract');
  });

  test('a type with no close match still gets a runnable fix', () => {
    const failure = thrownBy(() => readType('totallybogus'));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x test unit');
  });
});

describe('unit · readSample', () => {
  test('no --sample flag means no sampling', () => {
    expect(readSample(argsFor(['test']))).toBeUndefined();
  });

  test('a positive integer parses through', () => {
    expect(readSample(argsFor(['test', '--sample', '3']))).toBe(3);
  });

  test('0 is refused — sampling nothing is not a valid signal', () => {
    expect(thrownBy(() => readSample(argsFor(['test', '--sample', '0']))).code).toBe(
      'X_CLI_BAD_FLAG',
    );
  });

  test('a non-integer is refused, not silently truncated', () => {
    expect(thrownBy(() => readSample(argsFor(['test', '--sample', 'abc']))).code).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(thrownBy(() => readSample(argsFor(['test', '--sample', '2.5']))).code).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(thrownBy(() => readSample(argsFor(['test', '--sample', '-1']))).code).toBe(
      'X_CLI_BAD_FLAG',
    );
  });
});

describe('unit · missingSelection', () => {
  test('neither type nor filter carries nothing extra — todays exact behaviour', () => {
    expect(missingSelection(undefined, undefined)).toEqual({});
  });

  test('type alone is named', () => {
    expect(missingSelection('contract', undefined)).toEqual({ type: 'contract' });
  });

  test('filter alone is named', () => {
    expect(missingSelection(undefined, 'cache')).toEqual({ filter: 'cache' });
  });

  test('both are named together', () => {
    expect(missingSelection('contract', 'cache')).toEqual({ type: 'contract', filter: 'cache' });
  });

  test('the error it feeds names both, so a caller knows which half emptied the set', () => {
    const failure = new NoTestFilesError({
      root: '/repo',
      ...missingSelection('contract', 'cache'),
    });
    expect(failure.cause).toBe('no *.test.ts files of type contract matching "cache" under /repo');
  });
});

describe('unit · sampleFiles', () => {
  const files: readonly TestFile[] = [
    { path: 'b.test.ts', bytes: 200 },
    { path: 'a.test.ts', bytes: 200 },
    { path: 'c.test.ts', bytes: 900 },
    { path: 'd.test.ts', bytes: 50 },
  ];

  test('keeps at most N, largest first — the same order planShards relies on', () => {
    expect(sampleFiles(files, 2).map((file) => file.path)).toEqual(
      [...files]
        .sort(bySizeThenPath)
        .slice(0, 2)
        .map((file) => file.path),
    );
    expect(sampleFiles(files, 2).length).toBe(2);
  });

  test('never fails when N exceeds the file count — "at most", not "exactly"', () => {
    expect(sampleFiles(files, 99).length).toBe(files.length);
  });

  test('deterministic: two calls over the same input pick the same files', () => {
    expect(sampleFiles(files, 2).map((file) => file.path)).toEqual(
      sampleFiles(files, 2).map((file) => file.path),
    );
  });
});
