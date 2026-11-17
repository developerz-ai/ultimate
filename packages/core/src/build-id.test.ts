// The build id has ONE resolver: the boot's (`BUILD_ID` set and non-empty, else the manifest hash),
// installed here. Core read `process.env['BUILD_ID'] ?? 'dev'` itself, which keeps the `''` every
// unstamped image's Dockerfile writes (`ARG BUILD_ID=` → `ENV BUILD_ID=${BUILD_ID}`): the header
// named the manifest hash while `/healthz`, `/readyz` and a worker's `ctx.buildId` said `""`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installBuildId, installedBuildId } from './build-id';
import { ctxOf } from './context';
import { healthReport, resetLifecycle } from './lifecycle';

const before = process.env['BUILD_ID'];
const releases: (() => void)[] = [];

beforeEach(() => {
  // What every unstamped image runs with.
  process.env['BUILD_ID'] = '';
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  if (before === undefined) delete process.env['BUILD_ID'];
  else process.env['BUILD_ID'] = before;
  resetLifecycle();
});

describe('unit · the installed build id', () => {
  test('ctxOf() and the health report carry the installed id, never the empty BUILD_ID', () => {
    releases.push(installBuildId('manifest-hash-1'));
    expect(ctxOf().buildId).toBe('manifest-hash-1');
    expect(healthReport().buildId).toBe('manifest-hash-1');
  });

  test('outside any boot it is dev — the environment is the boot’s to read, not core’s', () => {
    process.env['BUILD_ID'] = 'stamped-by-hand';
    expect(installedBuildId()).toBe('dev');
    expect(ctxOf().buildId).toBe('dev');
    expect(healthReport().buildId).toBe('dev');
  });

  test('a release removes its own install alone, in any order', () => {
    const first = installBuildId('a');
    const second = installBuildId('b');
    releases.push(second);
    first();
    expect(installedBuildId()).toBe('b');
    second();
    expect(installedBuildId()).toBe('dev');
  });

  test('an explicit init still wins over the installed id', () => {
    releases.push(installBuildId('installed'));
    expect(ctxOf({ buildId: 'from-init' }).buildId).toBe('from-init');
  });
});
