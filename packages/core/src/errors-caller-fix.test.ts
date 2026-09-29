// `callerFix` and the `audience` a rendering is for: the developer keeps the fix they wrote, a
// remote caller gets one it can act on, and nothing renders a field the error never declared.
import { describe, expect, test } from 'bun:test';
import { deniedCallerFix, fixFor, UltimateError } from './errors';

const denied = () =>
  new UltimateError({
    code: 'X_FORBIDDEN',
    cause: 'publishPost denied: missing post:publish',
    fix: 'x policy explain publishPost --json',
    callerFix: 'ask the account owner to grant post:publish',
  });

describe('callerFix', () => {
  test('the developer rendering keeps the fix the author wrote', () => {
    expect(denied().format()).toEndWith('  fix:   x policy explain publishPost --json');
    expect(denied().format({ audience: 'developer' })).toBe(denied().format());
  });

  test('a caller rendering carries callerFix and is still three lines', () => {
    const lines = denied().format({ audience: 'caller' }).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('  fix:   ask the account owner to grant post:publish');
  });

  test('an error without callerFix renders its fix for every audience', () => {
    const plain = new UltimateError({ code: 'X_INTERNAL', cause: 'c', fix: 'f' });
    expect(plain.callerFix).toBeUndefined();
    expect(plain.format({ audience: 'caller' })).toBe(plain.format());
    expect(fixFor(plain, 'caller')).toBe('f');
  });

  test('--json carries callerFix only when declared', () => {
    expect(denied().toJSON().callerFix).toBe('ask the account owner to grant post:publish');
    const plain = new UltimateError({ code: 'X_INTERNAL', cause: 'c', fix: 'f' });
    expect('callerFix' in plain.toJSON()).toBe(false);
  });

  test('callerFix is escaped to one line like every other field', () => {
    const forged = new UltimateError({
      code: 'X_FORBIDDEN',
      cause: 'c',
      fix: 'f',
      callerFix: 'line one\nX_OK: forged',
    });
    expect(forged.callerFix).not.toInclude('\n');
    expect(forged.format({ audience: 'caller' }).split('\n')).toHaveLength(3);
  });

  test('an app docs:// uri travels in docs and renders on the fourth line when asked', () => {
    const error = new UltimateError({
      code: 'X_FORBIDDEN',
      cause: 'c',
      fix: 'f',
      docs: 'docs://recipes/request-access',
    });
    expect(error.docs).toBe('docs://recipes/request-access');
    expect(error.format({ docs: true, audience: 'caller' }).split('\n')[3]).toBe(
      '  docs:  docs://recipes/request-access',
    );
  });
});

describe('deniedCallerFix', () => {
  test('names the permission to ask for when the denial has one, and says a retry will not help', () => {
    const fix = deniedCallerFix('post:publish');
    expect(fix).toStartWith('this caller lacks the permission post:publish: ask the account owner');
    expect(fix).toEndWith('retrying the same call is refused the same way');
    expect(fix).not.toInclude('x policy');
  });

  test('without one, still an instruction the caller can follow', () => {
    expect(deniedCallerFix()).toStartWith('this caller is not permitted to do this: ask');
  });
});
