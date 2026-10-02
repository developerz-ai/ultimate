// Which password requests the replication client answers. Split from `pg-connection.test.ts` at
// the file ceiling: that file proves each method's bytes, this one proves WHEN a method is spoken.

import { describe, expect, test } from 'bun:test';
import { SCRAM_SHA_256 } from './pg-auth';
import { PgConnection } from './pg-connection';
import {
  authCleartext,
  authMd5,
  authOk,
  authSasl,
  decodeFrame,
  FakeStream,
  opts,
  readyForQuery,
} from './pg-connection-fixture';

/** The tag of the one message the client sent after its startup packet. */
const answerTag = (stream: FakeStream): string | undefined => {
  const bytes = stream.writes[1];
  return bytes === undefined ? undefined : decodeFrame(bytes).tag;
};

// A cleartext password is readable on the wire and an md5 one is replayable; on a session that
// is not guaranteed encrypted, anything on the path can ask for either and be handed it. The
// default `sslmode=prefer` guarantees nothing — a stripped upgrade falls back to cleartext.
describe('a password the network could read is sent only when the session mode allows it', () => {
  const weak = [
    ['cleartext', () => authCleartext()],
    ['md5', () => authMd5(new Uint8Array([1, 2, 3, 4]))],
  ] as const;

  for (const [label, request] of weak) {
    for (const ssl of [undefined, 'prefer', 'allow'] as const) {
      test(`${label} is refused under sslmode=${ssl ?? '(unstated)'}, and nothing is sent`, async () => {
        const stream = new FakeStream();
        stream.push(request(), authOk(), readyForQuery());
        const error = await PgConnection.open(
          opts(stream, { password: 'hunter2', ...(ssl === undefined ? {} : { ssl }) }),
        ).catch((caught: unknown) => caught);

        expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
        expect((error as { cause?: string }).cause).toContain('sslmode=require');
        expect(JSON.stringify(error)).not.toContain('hunter2');
        // Only the startup packet ever left: no PasswordMessage in any form.
        expect(stream.writes).toHaveLength(1);
        expect(stream.closed).toBe(true);
      });
    }

    for (const ssl of ['require', 'verify-ca', 'verify-full', 'disable'] as const) {
      test(`${label} is answered under sslmode=${ssl}`, async () => {
        const stream = new FakeStream();
        stream.push(request(), authOk(), readyForQuery());
        await PgConnection.open(opts(stream, { password: 'hunter2', ssl }));
        expect(answerTag(stream)).toBe('p');
      });
    }
  }

  test('SCRAM never puts the password on the wire, so it is answered under any mode', async () => {
    const stream = new FakeStream();
    stream.push(authSasl(SCRAM_SHA_256));
    // The stream ends after the client-first: what is proven is that one was SENT.
    stream.end();
    await PgConnection.open(opts(stream, { password: 'hunter2' })).catch(() => undefined);
    expect(answerTag(stream)).toBe('p');
  });
});
