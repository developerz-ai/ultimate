// What an unanswered call's error says about WHY: three readings, each driven through a real
// connection over a fake transport, because the reading is only worth having if the wire feeds it.

import { describe, expect, test } from 'bun:test';
import type { CdpTransport } from './cdp-connection';
import { cdpConnectOver } from './cdp-connection';

const wire = () => {
  let deliver: (text: string) => void = () => undefined;
  const transport: CdpTransport = {
    send: () => undefined,
    close: () => undefined,
    listen: (handlers) => {
      deliver = handlers.message;
    },
  };
  return {
    transport,
    frame: (frame: Record<string, unknown>): void => deliver(JSON.stringify(frame)),
    raw: (text: string): void => deliver(text),
  };
};

interface TimedOut {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly meta: Record<string, unknown>;
}

/** The call's own refusal, read as the four fields a failing job prints. */
const timedOut = async (call: Promise<unknown>): Promise<TimedOut> => {
  const thrown: unknown = await call.then(
    () => expect.unreachable('the call was answered'),
    (error: unknown) => error,
  );
  return thrown as TimedOut;
};

describe('X_CDP_TIMEOUT says which of three things happened', () => {
  test('the target did not answer: the browser kept talking, and none of it was this reply', async () => {
    const { transport, frame } = wire();
    const connection = cdpConnectOver(transport, 20);
    const call = connection.send('Runtime.evaluate', { expression: '1' }, 'page-1');
    frame({ method: 'Network.webSocketCreated', sessionId: 'worker-1', params: {} });
    frame({ id: 999, result: {} });
    frame({ method: 'Page.frameNavigated', sessionId: 'page-1', params: { frame: { id: 'f' } } });

    const error = await timedOut(call);
    expect(error.code).toBe('X_CDP_TIMEOUT');
    expect(error.meta).toMatchObject({
      method: 'Runtime.evaluate',
      sessionId: 'page-1',
      reading: 'no-answer',
      framesArrived: 3,
      framesDropped: 0,
      transportOpen: true,
      targetGone: null,
      navigations: 1,
      lastFrames: [
        'Network.webSocketCreated @worker-1',
        'reply 999',
        'Page.frameNavigated @page-1',
      ],
    });
    expect(error.cause).toContain('"Runtime.evaluate" did not answer inside 20ms');
    expect(error.cause).toContain('the target did not answer');
    expect(error.cause).toContain('the page navigated 1 time(s) since the call');
    // A silent target is not answered by a rerun: this reading keeps the timeoutMs instruction.
    expect(error.fix).toContain('installE2eDriver({ timeoutMs })');
  });

  test('the reply was lost in transport: frames arrived after the call that nothing could parse', async () => {
    const { transport, frame, raw } = wire();
    const connection = cdpConnectOver(transport, 20);
    raw('{"id":0,"resu'); // before the call: counted on the connection, not against this call
    const call = connection.send('Runtime.evaluate', { expression: '1' }, 'page-1');
    raw('{"id":1,"result":{"result":{"type":"num');
    raw('ber"}}}{"method":"Page.loadEventFired"');
    frame({ method: 'Network.dataReceived', sessionId: 'page-1', params: {} });

    const error = await timedOut(call);
    expect(error.meta).toMatchObject({
      reading: 'lost-in-transport',
      framesArrived: 1,
      framesDropped: 2,
      targetGone: null,
    });
    expect(error.cause).toContain('2 frame(s) arrived unparseable after it was sent');
    expect(error.cause).toContain('lost in transport');
    // `--json`, or the rerun prints neither `reading` nor `framesDropped`.
    expect(error.fix).toBe('x test e2e --json');
  });

  test('the target is gone: its session detached, or its tab crashed, under the call', async () => {
    const { transport, frame } = wire();
    const connection = cdpConnectOver(transport, 20);
    frame({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'page-1', targetInfo: { targetId: 'T1', type: 'page' } },
    });
    const detached = connection.send('Runtime.evaluate', { expression: '1' }, 'page-1');
    frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'page-1' } });
    const first = await timedOut(detached);
    expect(first.meta).toMatchObject({ reading: 'target-gone', targetGone: 'detached' });
    expect(first.cause).toContain('its target is gone (detached)');
    expect(first.fix).toBe('x test e2e --json');

    frame({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'page-2', targetInfo: { targetId: 'T2', type: 'page' } },
    });
    const crashed = connection.send('Runtime.evaluate', { expression: '1' }, 'page-2');
    frame({ method: 'Target.targetCrashed', params: { targetId: 'T2', status: 'crashed' } });
    expect((await timedOut(crashed)).meta).toMatchObject({
      reading: 'target-gone',
      targetGone: 'crashed',
    });
  });

  test('a browser that went silent altogether is told apart from one that kept talking', async () => {
    const { transport } = wire();
    const connection = cdpConnectOver(transport, 20);
    const error = await timedOut(connection.send('Browser.getVersion'));
    expect(error.meta).toMatchObject({ reading: 'no-answer', framesArrived: 0, sessionId: null });
    expect(error.cause).toContain('nothing at all arrived after the call was sent');
  });

  test('the frames it quotes are bounded: the last eight, however many arrived', async () => {
    const { transport, frame } = wire();
    const connection = cdpConnectOver(transport, 20);
    const call = connection.send('Runtime.evaluate', {}, 'page-1');
    for (let n = 0; n < 30; n += 1) frame({ method: `Event.number${String(n)}`, params: {} });
    const { meta } = await timedOut(call);
    expect(meta['framesArrived']).toBe(30);
    expect(meta['lastFrames']).toEqual(
      Array.from({ length: 8 }, (_, at) => `Event.number${String(22 + at)}`),
    );
  });
});
