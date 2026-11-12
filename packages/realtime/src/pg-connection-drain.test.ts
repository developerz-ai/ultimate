// `PgConnection.awaitCopyEnd`: after a CopyDone the walsender still answers, and a socket closed
// over that answer unread is reset — `Connection reset by peer` in the server log on every deploy.

import { describe, expect, test } from 'bun:test';
import {
  commandComplete,
  copyData,
  copyDoneFrame,
  errorResponse,
  FakeStream,
  openInCopyBoth,
  readyForQuery,
} from './pg-connection-fixture';

const never = new Promise<void>(() => undefined);

describe('awaitCopyEnd', () => {
  test('reads through the tail, CopyDone and CommandComplete to ReadyForQuery', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    await connection.endCopy();
    stream.push(copyData(new Uint8Array([0x6b])), copyDoneFrame(), commandComplete('COPY 0'));
    const drained = connection.awaitCopyEnd(never);
    stream.push(readyForQuery());
    expect(await drained).toBe(true);
    expect(connection.inCopyBoth).toBe(false);
  });

  test('an ErrorResponse on the way is read past, not thrown', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    stream.push(copyDoneFrame(), errorResponse({ C: '57P01', M: 'bye' }), readyForQuery());
    expect(await connection.awaitCopyEnd(never)).toBe(true);
  });

  test('gives up when the deadline settles first', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    let fire = (): void => undefined;
    const deadline = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const drained = connection.awaitCopyEnd(deadline);
    stream.push(copyDoneFrame());
    fire();
    expect(await drained).toBe(false);
  });

  test('a server that hangs up instead of answering is not a ReadyForQuery', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    stream.push(copyDoneFrame());
    stream.end();
    expect(await connection.awaitCopyEnd(never)).toBe(false);
  });
});
