// `/readyz` as `x status` and `x deploy verify` read it is a STRANGER's answer: the origin may be
// hostile. A build header carrying terminal controls, or a body of any size, must not reach the
// human output or the heap.

import { describe, expect, test } from 'bun:test';
import { BUILD_ID_HEADER, markListening } from '@ultimat3/core';
import { printableBuild, takeSample } from './cmd-deploy-verify-sample';

/** A real socket answering `/readyz` as `answer` says, announced so the test seal admits it. */
async function sampleFrom(answer: () => Response) {
  const server = Bun.serve({ hostname: 'localhost', port: 0, fetch: answer });
  const unmark = markListening(server.url.origin);
  try {
    return await takeSample(server.url.origin, 5_000);
  } finally {
    unmark();
    server.stop(true);
  }
}

describe('unit · a hostile /readyz', () => {
  test('a build value with a C1 control (CSI, \\x9b) or an escape is counted unstamped', async () => {
    for (const hostile of ['abc\u009b2J', 'abc\u001b[2J', 'a b', 'x'.repeat(129)]) {
      expect(printableBuild(hostile)).toBeNull();
    }
    expect(printableBuild('sha-1f2e3d')).toBe('sha-1f2e3d');
    const answer = await sampleFrom(
      () => new Response('{}', { headers: { [BUILD_ID_HEADER]: 'v1\u009b2J' } }),
    );
    expect(answer.build).toBeNull();
  });

  test('a body past 4 KiB is not parsed — its role is not read, the sample still counts', async () => {
    const padded = JSON.stringify({ role: 'worker', pad: 'x'.repeat(8_192) });
    const answer = await sampleFrom(() => new Response(padded));
    expect([answer.status, answer.role]).toEqual([200, null]);
    const small = await sampleFrom(() => new Response(JSON.stringify({ role: 'worker' })));
    expect(small.role).toBe('worker');
  });
});
