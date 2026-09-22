/**
 * The doubles every `clientTransport` suite drives: a recording fetch, a fetch that holds its answer
 * until released, a recording record sink installed on the page, and a rejection probe. Test-only —
 * excluded from the tarball by the `-fixture.ts` negation in `package.json`'s `files`.
 */

import { expect } from 'bun:test';
import type { FetchLike } from './client-dispatch';
import type { RecordRows } from './record-envelope';
import { pageClient } from './record-sink';

export interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that records every dispatch and answers from `respond`. */
export function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  readonly fetchImpl: FetchLike;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

/** A fetch that holds its answer until released, and rejects with AbortError when aborted. */
export function heldFetch(): {
  readonly fetchImpl: FetchLike;
  release(response: Response): void;
  aborted(): boolean;
} {
  let release: (response: Response) => void = () => {};
  let signal: AbortSignal | undefined;
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      release = resolve;
      signal = init.signal ?? undefined;
      signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  return {
    fetchImpl,
    release: (response) => release(response),
    aborted: () => signal?.aborted === true,
  };
}

export function recordingSink(): {
  adopted: [string, RecordRows][];
  removed: [string, readonly string[]][];
} {
  const adopted: [string, RecordRows][] = [];
  const removed: [string, readonly string[]][] = [];
  pageClient().store = {
    adopt: (type, rows) => adopted.push([type, rows]),
    remove: (type, keys) => removed.push([type, keys]),
  };
  return { adopted, removed };
}

export async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return expect.unreachable('the request resolved');
}
