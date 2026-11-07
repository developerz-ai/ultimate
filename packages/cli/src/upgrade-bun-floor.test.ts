// Every pin site, on the shapes the six surveyed adopters really carry: raised to the floor, never
// lowered, a second run changing nothing, and a digest kept and listed rather than edited.

import { describe, expect, test } from 'bun:test';
import { editBunSites, floorOf, isBunSite } from './upgrade-bun-floor';

const FLOOR = '1.4.4';

describe('unit · floorOf', () => {
  test('reads the version out of engines.bun', () => {
    expect(floorOf('>=1.4.4')).toBe('1.4.4');
    expect(floorOf('^1.3.0')).toBe('1.3.0');
  });
  test('answers undefined for a range it cannot name a floor from', () => {
    expect(floorOf('*')).toBeUndefined();
    expect(floorOf(undefined)).toBeUndefined();
  });
});

describe('unit · isBunSite', () => {
  test.each([
    '.bun-version',
    'package.json',
    'apps/web/package.json',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yaml',
    'docker/Dockerfile',
    'docker/Dockerfile.worker',
    'docker/web.dockerfile',
    'docker/docker-compose.yml',
  ])('%s is a site', (path) => {
    expect(isBunSite(path)).toBe(true);
  });
  test.each(['bun.lock', 'README.md', 'apps/web/src/index.ts'])('%s is not', (path) => {
    expect(isBunSite(path)).toBe(false);
  });
});

describe('unit · editBunSites', () => {
  test('.bun-version', () => {
    const result = editBunSites('.bun-version', '1.4.2\n', FLOOR);
    expect(result.text).toBe('1.4.4\n');
    expect(result.edited).toEqual([
      { path: '.bun-version', site: '.bun-version', from: '1.4.2', to: '1.4.4' },
    ]);
  });

  test('engines.bun and packageManager, the rest of the file byte-identical', () => {
    const source =
      '{\n  "name": "a",\n  "packageManager": "bun@1.3.14",\n  "engines":   { "bun": ">=1.3.0", "node": ">=22.0.0" },\n  "scripts": { "bun": "1.0.0" }\n}\n';
    const result = editBunSites('package.json', source, FLOOR);
    expect(result.text).toBe(
      '{\n  "name": "a",\n  "packageManager": "bun@1.4.4",\n  "engines":   { "bun": ">=1.4.4", "node": ">=22.0.0" },\n  "scripts": { "bun": "1.0.0" }\n}\n',
    );
    expect(result.edited.map((edit) => edit.site)).toEqual(['engines.bun', 'packageManager']);
  });

  // A range's version is its lower bound, not a floating tag: `>=1.4` admits 1.4.0.
  test.each([
    ['>=1.4', '>=1.4.4'],
    ['^1.4', '^1.4.4'],
  ])('engines.bun %s, two parts, is raised to the floor', (range, to) => {
    const result = editBunSites('package.json', `{ "engines": { "bun": "${range}" } }`, FLOOR);
    expect(result.text).toBe(`{ "engines": { "bun": "${to}" } }`);
    expect(result.edited).toEqual([{ path: 'package.json', site: 'engines.bun', from: range, to }]);
  });

  test('engines.bun >=1.5, two parts, already admits only the floor and above', () => {
    const source = '{ "engines": { "bun": ">=1.5" } }';
    expect(editBunSites('package.json', source, FLOOR)).toEqual({
      text: source,
      edited: [],
      manual: [],
    });
  });

  test('setup-bun, quoted and bare', () => {
    const source = "      with:\n        bun-version: '1.4.2'\n        bun-version: 1.3.14\n";
    const result = editBunSites('.github/workflows/ci.yml', source, FLOOR);
    expect(result.text).toBe(
      "      with:\n        bun-version: '1.4.4'\n        bun-version: 1.4.4\n",
    );
    expect(result.edited.map((edit) => edit.from)).toEqual(['1.4.2', '1.3.14']);
  });

  test('an expression cannot be resolved here, so it is listed untouched', () => {
    const source = '        bun-version: ${{ env.BUN_VERSION }}\n';
    const result = editBunSites('.github/workflows/ci.yml', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.line).toBe(1);
    expect(result.manual[0]?.text).toContain('env.BUN_VERSION');
  });

  test('bun-version-file and a bare input name are not pins', () => {
    const source = '  bun-version:\n    required: false\n  bun-version-file: .bun-version\n';
    const result = editBunSites('.github/actions/setup/action.yml', source, FLOOR);
    expect(result).toEqual({ text: source, edited: [], manual: [] });
  });

  test('an oven/bun tag keeps its suffix and its precision', () => {
    const source = 'FROM oven/bun:1.3-alpine AS deps\nFROM oven/bun:1.3.14-slim AS runtime\n';
    const result = editBunSites('docker/Dockerfile', source, FLOOR);
    expect(result.text).toBe(
      'FROM oven/bun:1.4-alpine AS deps\nFROM oven/bun:1.4.4-slim AS runtime\n',
    );
  });

  test('a floating tag that already reaches the floor is left alone', () => {
    const source = 'FROM oven/bun:1.4-alpine AS deps\nFROM oven/bun:latest\nFROM oven/bun:1\n';
    expect(editBunSites('docker/Dockerfile', source, FLOOR)).toEqual({
      text: source,
      edited: [],
      manual: [],
    });
  });

  test('a digest-pinned image is kept and listed, on every run', () => {
    const line = 'FROM oven/bun:1.4-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6 AS deps';
    const result = editBunSites('docker/Dockerfile', `${line}\n`, FLOOR);
    expect(result.text).toBe(`${line}\n`);
    expect(result.edited).toEqual([]);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]).toMatchObject({ path: 'docker/Dockerfile', line: 1, text: line });
    expect(result.manual[0]?.why).toContain('digest');
  });

  test('a build-arg tag is listed: only the Dockerfile author knows its value', () => {
    const source = 'FROM oven/bun:${BUN_VERSION}-alpine\n';
    const result = editBunSites('docker/Dockerfile', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.manual).toHaveLength(1);
  });

  test('a comment naming an image is prose', () => {
    const source = "# The digest is `oven/bun:1.3.2-alpine`'s\n";
    expect(editBunSites('docker/Dockerfile', source, FLOOR).text).toBe(source);
  });

  test('never lowers a site already above the floor', () => {
    expect(editBunSites('.bun-version', '1.5.0\n', FLOOR).edited).toEqual([]);
    const source = '{ "engines": { "bun": ">=1.5.0" }, "packageManager": "bun@1.5.0" }';
    expect(editBunSites('package.json', source, FLOOR).text).toBe(source);
    const image = 'FROM oven/bun:1.5.0-alpine\n';
    expect(editBunSites('Dockerfile', image, FLOOR).text).toBe(image);
  });

  test.each([
    ['.bun-version', '1.3.0\n'],
    ['package.json', '{ "engines": { "bun": ">=1.3.0" }, "packageManager": "bun@1.3.0" }'],
    ['.github/workflows/ci.yml', "        bun-version: '1.3.0'\n"],
    ['Dockerfile', 'FROM oven/bun:1.3-alpine\nFROM oven/bun:1.3.14\n'],
  ])('%s: a second run changes nothing', (path, source) => {
    const first = editBunSites(path, source, FLOOR);
    expect(first.text).not.toBe(source);
    const second = editBunSites(path, first.text, FLOOR);
    expect(second.text).toBe(first.text);
    expect(second.edited).toEqual([]);
  });

  test('CRLF survives', () => {
    const source = "        bun-version: '1.3.0'\r\n        run: x\r\n";
    expect(editBunSites('ci.yml', source, FLOOR).text).toBe(
      "        bun-version: '1.4.4'\r\n        run: x\r\n",
    );
  });

  test.each([
    ['at the floor', 'FROM oven/bun:1.4.4-alpine@sha256:abc123 AS deps'],
    ['above it', 'FROM oven/bun:1.5-alpine@sha256:abc123 AS deps'],
  ])('a digest whose tag is readable and %s is nobody’s business', (_name, line) => {
    expect(editBunSites('Dockerfile', `${line}\n`, FLOOR)).toEqual({
      text: `${line}\n`,
      edited: [],
      manual: [],
    });
  });

  test.each([
    ['below the floor', 'FROM oven/bun:1.3.14-alpine@sha256:abc123'],
    ['floating, so its patch cannot be read', 'FROM oven/bun:1.4-alpine@sha256:abc123'],
    ['with no version at all', 'FROM oven/bun:latest@sha256:abc123'],
  ])('a digest whose tag is %s is listed', (_name, line) => {
    const result = editBunSites('Dockerfile', `${line}\n`, FLOOR);
    expect(result.text).toBe(`${line}\n`);
    expect(result.manual).toHaveLength(1);
  });

  test.each([
    ['engines.bun, an x-range', '{ "engines": { "bun": "1.3.x" } }'],
    ['engines.bun, a capped range', '{ "engines": { "bun": ">=1.3.0 <1.4.0" } }'],
    ['packageManager with a hash', '{ "packageManager": "bun@1.3.6+sha512.abc" }'],
  ])('%s cannot be raised cleanly: listed with its line, byte-identical', (_name, source) => {
    const result = editBunSites('package.json', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.edited).toEqual([]);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.line).toBe(1);
    expect(result.manual[0]?.path).toBe('package.json');
  });

  test('the line a manifest lists is the line it is on', () => {
    const source = '{\n  "name": "a",\n  "engines": {\n    "bun": "1.3.x"\n  }\n}\n';
    expect(editBunSites('package.json', source, FLOOR).manual[0]?.line).toBe(4);
  });

  test('those spellings already at the floor are left alone and unlisted', () => {
    for (const source of [
      '{ "engines": { "bun": ">=1.5.0 <2.0.0" } }',
      '{ "packageManager": "bun@1.5.0+sha512.abc" }',
    ]) {
      expect(editBunSites('package.json', source, FLOOR)).toEqual({
        text: source,
        edited: [],
        manual: [],
      });
    }
  });

  test('setup-bun with an x-range is listed', () => {
    const source = '        bun-version: 1.3.x\n';
    const result = editBunSites('ci.yml', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.manual).toHaveLength(1);
  });

  test.each(['v1.3.0\n', '1.3\n'])('.bun-version %j is listed', (source) => {
    const result = editBunSites('.bun-version', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.manual).toHaveLength(1);
  });

  test('a v-prefixed image tag below the floor is listed', () => {
    const source = 'FROM oven/bun:v1.3.0\n';
    const result = editBunSites('Dockerfile', source, FLOOR);
    expect(result.text).toBe(source);
    expect(result.manual).toHaveLength(1);
  });
});
