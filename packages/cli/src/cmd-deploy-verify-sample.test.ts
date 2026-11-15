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
  // MATCHING reads the header as sent: a legal BUILD_ID with a space, or past 128 characters, is
  // the stamp `x deploy verify --build` compares against. Screening it here failed a stamped image
  // as X_DEPLOY_BUILD_UNSTAMPED (`x-ultimate-build: release 31.27.0`).
  test('the build is the header as sent; only an empty one is no build', async () => {
    for (const stamped of ['release 31.27.0', 'x'.repeat(200), 'v1\u009b2J']) {
      const answer = await sampleFrom(
        () => new Response('{}', { headers: { [BUILD_ID_HEADER]: stamped } }),
      );
      expect(answer.build).toBe(stamped);
    }
    const empty = await sampleFrom(
      () => new Response('{}', { headers: { [BUILD_ID_HEADER]: '' } }),
    );
    expect(empty.build).toBeNull();
  });

  // PRINTING is where the stranger's bytes are screened: a C1 CSI (\x9b) or ESC rewrites the
  // terminal `x status` prints to, and JSON leaves a C1 control unescaped.
  test('a printed build escapes every control and is cut at 128 characters', () => {
    expect(printableBuild('sha-1f2e3d')).toBe('sha-1f2e3d');
    expect(printableBuild('release 31.27.0')).toBe('release 31.27.0');
    expect(printableBuild('abc\u009b2J')).toBe('abc\\u009b2J');
    expect(printableBuild('abc\u001b[2J')).toBe('abc\\u001b[2J');
    expect(printableBuild('a\u2028b')).toBe('a\\u2028b');
    const long = printableBuild('x'.repeat(200));
    expect(long).toBe(`${'x'.repeat(128)}…`);
    for (const value of ['abc\u009b2J', 'a\u001bb', 'x'.repeat(200)]) {
      expect(printableBuild(value)).toMatch(/^[\x20-\x7e]*…?$/);
    }
  });

  test('a body past 4 KiB is not parsed — its role is not read, the sample still counts', async () => {
    const padded = JSON.stringify({ role: 'worker', pad: 'x'.repeat(8_192) });
    const answer = await sampleFrom(() => new Response(padded));
    expect([answer.status, answer.role]).toEqual([200, null]);
    const small = await sampleFrom(() => new Response(JSON.stringify({ role: 'worker' })));
    expect(small.role).toBe('worker');
  });
});
