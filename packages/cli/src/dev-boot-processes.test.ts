// `x dev` is always one process (owner ruling): a `ULTIMATE_PROCESSES` count its `.env` carries
// for production is ignored there, never refused, and said once so the ignored setting is visible.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import { bootDevFixture } from './cmd-dev-boot-fixture';

const lines: string[] = [];
let release: (() => void) | undefined;
// Installed before the fixture's own `beforeAll` boots, so the boot's lines land here.
beforeAll(() => {
  release = installLogSink((line) => {
    lines.push(line);
  });
});
afterAll(() => release?.());

const dev = bootDevFixture('.dev-boot-processes-fixture', { env: { ULTIMATE_PROCESSES: '4' } });

const withMsg = (msg: string): readonly string[] =>
  lines.filter((line) => line.includes(`"msg":"${msg}"`));

describe('unit · x dev with ULTIMATE_PROCESSES=4', () => {
  test('serves every role in this one process and says once that the count is ignored', () => {
    // The roles run here, in the test's own process: no child was spawned to hold them.
    expect(dev.server.running.server).not.toBeNull();
    expect(dev.server.running.worker).toBeDefined();
    expect(withMsg('ultimate processes starting')).toEqual([]);
    const ignored = withMsg('ultimate processes ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"level":"info"');
    expect(ignored[0]).toContain('ULTIMATE_PROCESSES=4');
  });
});
