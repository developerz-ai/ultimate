// Row t: the e2e preload leaked its `x dev` child when the browser would not open, and a CDP
// handshake that timed out left its socket dialling.

import { afterEach, describe, expect, test } from 'bun:test';
import { cdpConnect } from './cdp-connection';
import { openOrStop } from './e2e-preload';

const RealWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
});

describe('unit · a failed browser start releases what it started', () => {
  test('a browser that will not open stops the app, and the open error is the one reported', async () => {
    let stopped = 0;
    const refused = new TypeError('no chrome');
    const failure = await openOrStop(
      {
        stop: async () => {
          stopped += 1;
        },
      },
      async () => {
        throw refused;
      },
    ).catch((error: unknown) => error);
    expect(failure).toBe(refused);
    expect(stopped).toBe(1);
  });

  test('a CDP handshake that times out closes its socket', async () => {
    const closed: string[] = [];
    class NeverOpens {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {}
      close(): void {
        closed.push(this.url);
      }
    }
    globalThis.WebSocket = NeverOpens as unknown as typeof WebSocket;
    const failure = await cdpConnect({ endpoint: 'ws://127.0.0.1:1/devtools', timeoutMs: 5 }).catch(
      (error: unknown) => error as { code: string },
    );
    expect((failure as { code: string }).code).toBe('X_CDP_TIMEOUT');
    expect(closed).toEqual(['ws://127.0.0.1:1/devtools']);
  });
});
