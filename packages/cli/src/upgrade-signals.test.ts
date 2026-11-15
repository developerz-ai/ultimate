// A stopped `x upgrade` stops what it started: every child carries the hop's tag, a SIGTERM or
// SIGINT kills the tagged tree, runs the cleanup, and only then meets the signal's default action.

import { describe, expect, test } from 'bun:test';
import type { Runner } from './exec';
import { stopChildrenOnSignal, tagRunner, upgradeTag } from './upgrade-signals';
import { STEP_TAG_ENV } from './verify-deadline';

const seen: { env: Readonly<Record<string, string | undefined>> | undefined }[] = [];
const inner: Runner = async (command, options) => {
  seen.push({ env: options.env });
  options.onSpawn?.(4242);
  return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
};

describe('unit · x upgrade, signals', () => {
  test('every child carries the tag, beside one an outer gate already set', async () => {
    seen.length = 0;
    const pids = new Set<number>();
    const tag = upgradeTag(7);
    await tagRunner(inner, tag, {}, pids)(['bun', 'install'], { cwd: '.' });
    await tagRunner(
      inner,
      tag,
      { [STEP_TAG_ENV]: 'outer' },
      pids,
    )(['bun', 'x'], {
      cwd: '.',
      env: { KEEP: '1' },
    });
    expect(seen[0]?.env?.[STEP_TAG_ENV]).toBe(tag);
    expect(seen[1]?.env).toEqual({ KEEP: '1', [STEP_TAG_ENV]: `outer ${tag}` });
    expect([...pids]).toEqual([]);
  });

  test('a signal kills the tagged tree, cleans up, then re-raises the same signal — once', async () => {
    const order: string[] = [];
    const listening = process.listeners('SIGTERM').length;
    let reraised: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      reraised = resolve;
    });
    const undo = stopChildrenOnSignal({
      tag: 'x-upgrade-7',
      pids: new Set([4242]),
      kill: async (tag, pids) => {
        order.push(`kill ${tag} ${[...pids].join(',')}`);
      },
      cleanup: () => order.push('cleanup'),
      reraise: (signal) => {
        order.push(`reraise ${signal}`);
        reraised();
      },
    });
    try {
      process.emit('SIGTERM', 'SIGTERM');
      process.emit('SIGTERM', 'SIGTERM');
      await done;
      expect(order).toEqual(['kill x-upgrade-7 4242', 'cleanup', 'reraise SIGTERM']);
      expect(process.listeners('SIGTERM').length).toBe(listening);
    } finally {
      undo();
    }
  });

  test('undo leaves no listener behind on the normal path', () => {
    const before = process.listeners('SIGINT').length;
    const undo = stopChildrenOnSignal({
      tag: 't',
      pids: new Set(),
      kill: async () => undefined,
      cleanup: () => undefined,
      reraise: () => undefined,
    });
    expect(process.listeners('SIGINT').length).toBe(before + 1);
    undo();
    expect(process.listeners('SIGINT').length).toBe(before);
  });
});
