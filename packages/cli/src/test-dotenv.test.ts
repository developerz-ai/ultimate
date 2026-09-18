// `x verify`/`x test` leaking `.env.development` into `bun test` children: this pins the pure
// decision (`devOnlyLeakedKeys`) that closes it, and the parser (`parseDotenvValues`) it stands
// on. `test-shards.test.ts`, `verify-tests.test.ts` and `verify-test-run.test.ts` each pin their
// own call site wiring `testEnvOverrides` into a spawned `bun test` — this file is the one place
// the VALUE comparison itself is asserted, quoting included.

import { describe, expect, test } from 'bun:test';
import { devOnlyLeakedKeys, parseDotenvValues, testEnvOverrides } from './test-dotenv';

describe('unit · parseDotenvValues', () => {
  test('a bare KEY=VALUE line', () => {
    expect(parseDotenvValues('FOO=bar').get('FOO')).toBe('bar');
  });

  test('an `export ` prefix is stripped', () => {
    expect(parseDotenvValues('export FOO=bar').get('FOO')).toBe('bar');
  });

  test('a whole-line comment and a blank line are skipped, never read as a key', () => {
    const parsed = parseDotenvValues('# a comment\n\nFOO=bar\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('FOO')).toBe('bar');
  });

  test('an empty value is a real, present key — not the same as absent', () => {
    const parsed = parseDotenvValues('FOO=');
    expect(parsed.has('FOO')).toBe(true);
    expect(parsed.get('FOO')).toBe('');
  });

  test('an unquoted value stops at an inline `#` comment', () => {
    expect(parseDotenvValues('FOO=bar # trailing note').get('FOO')).toBe('bar');
  });

  test('a double-quoted value keeps an internal `#`, and its own surrounding space', () => {
    expect(parseDotenvValues('FOO=" bar # baz "').get('FOO')).toBe(' bar # baz ');
  });

  test('a single-quoted value is quoted the same way', () => {
    expect(parseDotenvValues("FOO='bar#baz'").get('FOO')).toBe('bar#baz');
  });

  test('a later line overrides an earlier one for the same key, one file at a time', () => {
    expect(parseDotenvValues('FOO=first\nFOO=second').get('FOO')).toBe('second');
  });

  test('a `constructor`-named key is a real entry, not a prototype method', () => {
    const parsed = parseDotenvValues('constructor=bar');
    expect(parsed.get('constructor')).toBe('bar');
    expect(typeof parsed.get('__proto__')).not.toBe('function');
  });

  test('a line with no `=` and a key that fails the identifier grammar are both skipped', () => {
    const parsed = parseDotenvValues('not a line\n1BAD=x\nFOO=bar');
    expect(parsed.size).toBe(1);
    expect(parsed.get('FOO')).toBe('bar');
  });
});

describe('unit · devOnlyLeakedKeys', () => {
  test('a dotenv key that names an Object.prototype member is read as data, not inherited', () => {
    // `constructor=x` in a dotenv is legal. The environment does not set it, so it did not leak —
    // and the read must not be answered by `Object.prototype.constructor`.
    expect(devOnlyLeakedKeys({ devText: 'constructor=x', devLocalText: '', env: {} })).toEqual([]);
    expect(
      devOnlyLeakedKeys({ devText: 'constructor=x', devLocalText: '', env: { constructor: 'x' } }),
    ).toEqual(['constructor']);
  });

  test('a key the dev file sets, present in env with the SAME value, is leaked', () => {
    expect(
      devOnlyLeakedKeys({ devText: 'FOO=dev', devLocalText: '', env: { FOO: 'dev' } }),
    ).toEqual(['FOO']);
  });

  test('a key the real environment overrides — a DIFFERENT current value — is kept, not leaked', () => {
    // This is the case the task calls out by name: something other than `.env.development` set
    // this key (a real export, CI, `.env.local`), and this function must not touch it.
    expect(
      devOnlyLeakedKeys({ devText: 'FOO=dev', devLocalText: '', env: { FOO: 'ci-value' } }),
    ).toEqual([]);
  });

  test('a key the dev file never mentions is never reported, whatever env holds', () => {
    expect(
      devOnlyLeakedKeys({ devText: 'FOO=dev', devLocalText: '', env: { BAR: 'anything' } }),
    ).toEqual([]);
  });

  test('`.env.development.local` wins over `.env.development` for the same key', () => {
    // Matches Bun's own precedence (probed): a `.local` override is the higher-precedence file,
    // so the CURRENT value has to match the local one, not the file underneath it.
    const input = { devText: 'FOO=dev', devLocalText: 'FOO=local-dev', env: { FOO: 'local-dev' } };
    expect(devOnlyLeakedKeys(input)).toEqual(['FOO']);
    // And the value the base file alone would have set is no longer what decides it.
    expect(devOnlyLeakedKeys({ ...input, env: { FOO: 'dev' } })).toEqual([]);
  });

  test('an empty-string dev value only leaks when the current value is ALSO the empty string', () => {
    expect(devOnlyLeakedKeys({ devText: 'FOO=', devLocalText: '', env: { FOO: '' } })).toEqual([
      'FOO',
    ]);
    expect(devOnlyLeakedKeys({ devText: 'FOO=', devLocalText: '', env: {} })).toEqual([]);
  });

  test('a key a legitimate test file (.env.test) would ALSO set is still leaked', () => {
    // Probed: an ambient var shadows a dotenv file's own value for the same key, so leaving this
    // key in place would go on shadowing `.env.test`'s real value exactly as it shadows it today.
    // See this file's module header for the probe. Nothing about `.env.test` changes the verdict.
    expect(
      devOnlyLeakedKeys({ devText: 'FOO=dev', devLocalText: '', env: { FOO: 'dev' } }),
    ).toEqual(['FOO']);
  });

  test('several keys resolve independently', () => {
    const leaked = devOnlyLeakedKeys({
      devText: 'FOO=dev\nBAR=shared\nBAZ=untouched',
      devLocalText: '',
      env: { FOO: 'dev', BAR: 'shared', BAZ: 'something-else' },
    });
    expect([...leaked].sort()).toEqual(['BAR', 'FOO']);
  });
});

describe('unit · testEnvOverrides', () => {
  test('a root with no dotenv files at all overrides nothing', () => {
    expect(testEnvOverrides('/does/not/exist', { FOO: 'dev' })).toEqual({});
  });
});
