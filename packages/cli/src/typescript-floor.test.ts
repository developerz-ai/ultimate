// An existing app's TypeScript against the scaffold's: what lags, what is left alone, and the one
// `bun add` that moves each lagging manifest.

import { describe, expect, test } from 'bun:test';
import { TYPESCRIPT_VERSION } from './templates/scaffold-repo';
import { isBelow, lowerBound, typescriptLags } from './typescript-floor';

const manifest = (file: string, block: Record<string, unknown>) => ({
  file,
  text: JSON.stringify(block),
});

describe('a typescript range below the scaffold`s', () => {
  test('is a lag naming the file, both ranges and the bun add that moves it', () => {
    const lags = typescriptLags([
      manifest('package.json', { devDependencies: { typescript: '^6.0.3' } }),
    ]);
    expect(lags).toEqual([
      {
        file: 'package.json',
        field: 'devDependencies',
        from: '^6.0.3',
        to: TYPESCRIPT_VERSION,
        fix: `bun add -d 'typescript@${TYPESCRIPT_VERSION}'`,
      },
    ]);
  });

  test('defaults to the scaffold constant, never a restated literal', () => {
    const [lag] = typescriptLags([
      manifest('package.json', { devDependencies: { typescript: '1' } }),
    ]);
    expect(lag?.to).toBe(TYPESCRIPT_VERSION);
  });

  test('a workspace runtime dependency: no -d, and --cwd into the workspace', () => {
    const lags = typescriptLags(
      [manifest('apps/web/package.json', { dependencies: { typescript: '~5.9.2' } })],
      '^7.0.2',
    );
    expect(lags.map((lag) => lag.fix)).toEqual(["bun add 'typescript@^7.0.2' --cwd apps/web"]);
  });

  test.each([['^6.0.3'], ['6.0.3'], ['>=5.4'], ['~7.0.1'], ['^7.0.0-beta.1']])(
    '%s is below ^7.0.2',
    (range) => {
      const lags = typescriptLags(
        [manifest('package.json', { devDependencies: { typescript: range } })],
        '^7.0.2',
      );
      expect(lags).toHaveLength(1);
    },
  );
});

describe('what is not judged a lag', () => {
  test.each([['^7.0.2'], ['7.0.2'], ['^7.1.0'], ['^8.0.0'], ['~7.0.2-rc.1']])(
    '%s meets ^7.0.2',
    (range) => {
      const lags = typescriptLags(
        [manifest('package.json', { devDependencies: { typescript: range } })],
        '^7.0.2',
      );
      expect(lags).toEqual([]);
    },
  );

  test.each([['latest'], ['catalog:'], ['workspace:*'], ['5 || 6'], ['*']])(
    'an unreadable range, %s, says nothing',
    (range) => {
      const lags = typescriptLags(
        [manifest('package.json', { devDependencies: { typescript: range } })],
        '^7.0.2',
      );
      expect(lags).toEqual([]);
    },
  );

  test('no typescript, a non-string, or a manifest that is not JSON', () => {
    const lags = typescriptLags(
      [
        manifest('package.json', { devDependencies: { biome: '2' } }),
        manifest('apps/web/package.json', { devDependencies: { typescript: 6 } }),
        { file: 'packages/a/package.json', text: '{ not json' },
      ],
      '^7.0.2',
    );
    expect(lags).toEqual([]);
  });
});

describe('the comparison', () => {
  test('lower bounds read part by part, missing parts as zero', () => {
    expect(lowerBound('^6.0.3')).toEqual([6, 0, 3]);
    expect(lowerBound('>= 7')).toEqual([7, 0, 0]);
    expect(lowerBound('npm:typescript@7')).toBeUndefined();
    expect(isBelow([6, 9, 9], [7, 0, 2])).toBe(true);
    expect(isBelow([7, 0, 1], [7, 0, 2])).toBe(true);
    expect(isBelow([7, 0, 2], [7, 0, 2])).toBe(false);
    expect(isBelow([10, 0, 0], [7, 0, 2])).toBe(false);
  });
});
