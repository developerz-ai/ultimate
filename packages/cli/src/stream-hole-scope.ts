// What is ambient inside a `<Hole>` of a `stream` page: the request's context, with the hole's own
// signal (its deadline, the client's disconnect, the document's close) in place of the request's,
// and the response headers sealed — they left with the first flush, so a write there was a cookie
// or a `Location` nobody would ever receive.

import { runWithContext, tryUseContext, UltimateError } from '@ultimat3/core';
import type { HoleEnter } from '@ultimat3/render/server';

const FIX =
  'load: async () => { setCookie(name, value); return data; },   // in defineRoute, never inside a Hole';

/** A response header or redirect written under a hole, after the status and headers were sent. */
export class StreamAlreadyFlushedError extends UltimateError {
  constructor(what: string) {
    super({
      code: 'X_STREAM_ALREADY_FLUSHED',
      cause: `${what} ran inside a <Hole> on a render: 'stream' page, after the status and headers were sent with the first flush, so the browser would never receive it`,
      fix: FIX,
    });
  }
}

/** Every write to the response headers refuses; every read answers what was sent. */
const sealedHeaders = (headers: Headers): Headers =>
  new Proxy(headers, {
    get(target, key) {
      if (key === 'append' || key === 'set' || key === 'delete') {
        return (name: string) => {
          throw new StreamAlreadyFlushedError(`writing the ${name} response header (setCookie)`);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/**
 * The scope a hole's children run in. Forwarded rather than rebuilt, as `runToCompletion` forwards a
 * request's context: a rebuilt `ctxOf` drops the http fields, and `useRequestHeader()` inside a hole
 * would then refuse. Services the request built keep the request's signal; the ambient one is the hole's.
 */
export const enterHole: HoleEnter = (signal, run) => {
  const parent = tryUseContext();
  if (parent === undefined) return run();
  const sealed = sealedHeaders((parent as { readonly headers?: Headers }).headers ?? new Headers());
  const scope = new Proxy(parent, {
    get: (target, key) =>
      key === 'signal' ? signal : key === 'headers' ? sealed : Reflect.get(target, key),
    set: (target, key, value) => {
      if (key === 'redirect') throw new StreamAlreadyFlushedError('setRedirect()');
      return Reflect.set(target, key, value);
    },
  });
  return runWithContext(scope, run);
};
