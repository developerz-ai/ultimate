// The live test's fixture child, in-process: it answers with its own index and pid — what
// `supervise.live.test.ts` tells children apart by — and gives its listeners and link back on leave.

import { describe, expect, test } from 'bun:test';
import { allowHost } from '@ultimat3/testing';
import { serveFixtureChild } from './supervise-live-fixture';

describe('unit · the supervise live fixture', () => {
  test('a child answers `<index> <pid>` and closes its port on leave', async () => {
    const child = serveFixtureChild({ ULTIMATE_CHILD: '1/2', PORT: '0' }, { index: 1, count: 2 });
    const { host } = new URL(child.url);
    allowHost(host);
    expect(await (await fetch(child.url)).text()).toBe(`1 ${String(process.pid)}`);
    await child.leave();
    const after = await fetch(child.url).then(
      () => 'answered',
      () => 'closed',
    );
    expect(after).toBe('closed');
  });
});
