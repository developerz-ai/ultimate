// Between two files of one shared worker: what the last file put on `globalThis` is taken back.

import { describe, expect, test } from 'bun:test';
import { captureGlobals, restoreEnv, restoreGlobals } from './file-boundary';

describe('unit · file boundary globals', () => {
  test('a global the last file ADDED (a leaked fake window) is deleted', () => {
    const host: Record<string, unknown> = { fetch: 'real' };
    const snapshot = captureGlobals(host);
    host['window'] = {};
    host['document'] = {};
    expect(restoreGlobals(snapshot, host)).toEqual(['window', 'document']);
    expect(Object.keys(host)).toEqual(['fetch']);
  });

  test('a global the last file REPLACED is put back, and one it deleted comes back', () => {
    const real = (): string => 'real';
    const host: Record<string, unknown> = { fetch: real, crypto: 'c' };
    const snapshot = captureGlobals(host);
    host['fetch'] = () => 'stub';
    delete host['crypto'];
    restoreGlobals(snapshot, host);
    expect(host['fetch']).toBe(real);
    expect(host['crypto']).toBe('c');
  });

  test('module-installed helper slots (__extends, __SEROVAL_REFS__) are kept', () => {
    const host: Record<string, unknown> = {};
    const snapshot = captureGlobals(host);
    host['__extends'] = () => undefined;
    host['__SEROVAL_REFS__'] = new Map();
    expect(restoreGlobals(snapshot, host)).toEqual([]);
    expect(Object.keys(host)).toEqual(['__extends', '__SEROVAL_REFS__']);
  });

  test('a property the host refuses to change is left alone, never a throw', () => {
    const host: Record<string, unknown> = {};
    const snapshot = captureGlobals(host);
    Object.defineProperty(host, 'frozen', { value: 1, configurable: false });
    expect(() => restoreGlobals(snapshot, host)).not.toThrow();
    expect(host['frozen']).toBe(1);
  });
});

describe('unit · file boundary env', () => {
  test('a key the last file set is removed, and one it changed or deleted comes back', () => {
    const env: Record<string, string | undefined> = { A: '1', B: '2' };
    const snapshot = { ...env };
    env['ULTIMATE_EVAL_RECORD'] = '1';
    env['A'] = 'changed';
    delete env['B'];
    expect([...restoreEnv(snapshot, env)].sort()).toEqual(['A', 'B', 'ULTIMATE_EVAL_RECORD']);
    expect(env).toEqual({ A: '1', B: '2' });
  });
});
