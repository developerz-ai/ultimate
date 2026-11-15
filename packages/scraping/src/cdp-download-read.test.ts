// `readCapped` against a scripted protocol session: which responses it leaves to Chrome, and that
// every path past the taken stream releases the response, even when the release itself fails.

import { describe, expect, test } from 'bun:test';
import { type PausedResponse, readCapped } from './cdp-download-read';
import type { CdpSessionLike } from './cdp-port';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

/** A session answering from `script`; a method the script rejects rejects, an absent one is `{}`. */
const scripted = (
  script: Readonly<Record<string, ((params: Record<string, unknown>) => unknown) | 'reject'>>,
): { readonly session: CdpSessionLike; readonly sent: Sent[] } => {
  const sent: Sent[] = [];
  const session: CdpSessionLike = {
    send: (method, params) => {
      sent.push({ method, params });
      const answer = Object.hasOwn(script, method) ? script[method] : undefined;
      if (answer === 'reject') return Promise.reject(new TypeError(`${method} refused`));
      return Promise.resolve(answer === undefined ? {} : answer(params ?? {}));
    },
    detach: () => Promise.resolve(),
  };
  return { session, sent };
};

const paused = (over: Partial<PausedResponse> = {}): PausedResponse => ({
  requestId: 'r1',
  status: 200,
  headers: [{ name: 'content-type', value: 'text/csv' }],
  declaredLength: undefined,
  attachment: true,
  ...over,
});

const chunks = (...parts: readonly string[]) => {
  let at = 0;
  return () => {
    const data = parts[at] ?? '';
    at += 1;
    return { data: btoa(data), base64Encoded: true, eof: at >= parts.length };
  };
};

const methods = (sent: readonly Sent[]): readonly string[] => sent.map((each) => each.method);

describe('readCapped', () => {
  test('a body declared over the cap is left to Chrome, its stream never taken', async () => {
    const { session, sent } = scripted({});
    const read = await readCapped(session, paused({ declaredLength: 11 }), 10, () => undefined);
    expect(read).toEqual({ released: false });
    expect(sent).toEqual([]);
  });

  test('an undeclared body that is not an attachment is left too', async () => {
    const { session, sent } = scripted({});
    const read = await readCapped(session, paused({ attachment: false }), 10, () => undefined);
    expect(read).toEqual({ released: false });
    expect(sent).toEqual([]);
  });

  test('a stream Chrome will not hand over leaves the response as it was', async () => {
    const { session } = scripted({ 'Fetch.takeResponseBodyAsStream': 'reject' });
    expect(await readCapped(session, paused(), 10, () => undefined)).toEqual({ released: false });
  });

  test('under the cap the very bytes read are kept and fulfilled, even if the close fails', async () => {
    const kept: string[] = [];
    const { session, sent } = scripted({
      'Fetch.takeResponseBodyAsStream': () => ({ stream: 'h1' }),
      'IO.read': chunks('a,b\n', '1,2\n'),
      'IO.close': 'reject',
    });
    const read = await readCapped(session, paused(), 10, (body) =>
      kept.push(new TextDecoder().decode(body)),
    );
    expect(read).toEqual({ released: true });
    expect(kept).toEqual(['a,b\n1,2\n']);
    const fulfil = sent.find((each) => each.method === 'Fetch.fulfillRequest');
    expect(fulfil?.params?.['body']).toBe(btoa('a,b\n1,2\n'));
  });

  test('past the cap the read stops and the response is aborted, when both releases fail', async () => {
    const kept: Uint8Array[] = [];
    const { session, sent } = scripted({
      'Fetch.takeResponseBodyAsStream': () => ({ stream: 'h1' }),
      'IO.read': chunks('123456', '789012', 'never read'),
      'IO.close': 'reject',
      'Fetch.failRequest': 'reject',
    });
    const read = await readCapped(session, paused(), 10, (body) => kept.push(body));
    expect(read).toEqual({ released: true });
    expect(kept).toEqual([]);
    expect(methods(sent)).toEqual([
      'Fetch.takeResponseBodyAsStream',
      'IO.read',
      'IO.read',
      'IO.close',
      'Fetch.failRequest',
    ]);
    expect(sent.at(-1)?.params?.['errorReason']).toBe('Aborted');
  });

  test('a stream that breaks mid-read fails the response, even if the fail is refused', async () => {
    const { session, sent } = scripted({
      'Fetch.takeResponseBodyAsStream': () => ({ stream: 'h1' }),
      'IO.read': 'reject',
      'Fetch.failRequest': 'reject',
    });
    expect(await readCapped(session, paused(), 10, () => undefined)).toEqual({ released: true });
    expect(sent.at(-1)).toEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r1', errorReason: 'Failed' },
    });
  });
});
