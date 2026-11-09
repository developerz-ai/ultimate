// Single responsibility: the disk an app resolves through `defineStorage`, reporting each call on
// core's instrumentation bus as `storage.<verb>` inside a client span. One wrapper over the
// `StorageDriver` contract, so every driver — shipped or third-party — is instrumented the same.

import type { StorageEvent } from '@ultimat3/core';
import { instrument, subscribed, withSpan } from '@ultimat3/core';
import type { StorageDriver } from './driver';

type StorageVerb = 'put' | 'get' | 'stat' | 'copy' | 'delete' | 'list';

/** Which event each instrumented method reports as: a streamed write is a put, a stream a get. */
const VERB_OF: Readonly<Record<string, StorageVerb>> = Object.freeze({
  put: 'put',
  putStream: 'put',
  get: 'get',
  stream: 'get',
  streamRange: 'get',
  stat: 'stat',
  copy: 'copy',
  delete: 'delete',
  list: 'list',
});

/** The key a call is ABOUT: the destination of a copy, the prefix of a listing. */
function keyOf(method: string, args: readonly unknown[]): string {
  if (method === 'copy') return typeof args[1] === 'string' ? args[1] : '';
  if (method === 'list') {
    const options = args[0];
    const prefix =
      typeof options === 'object' && options !== null && 'prefix' in options
        ? options.prefix
        : undefined;
    return typeof prefix === 'string' ? prefix : '';
  }
  return typeof args[0] === 'string' ? args[0] : '';
}

/** A size the answer states — `StorageObject.size`, or a `get()`'s object — never a guess. */
function bytesOf(answer: unknown): number | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const holder = 'object' in answer ? answer.object : answer;
  if (typeof holder !== 'object' || holder === null || !('size' in holder)) return undefined;
  return typeof holder.size === 'number' ? holder.size : undefined;
}

function report(name: `storage.${StorageVerb}`, event: StorageEvent): void {
  if (subscribed(name)) instrument(name, event);
}

/**
 * The driver, every contract method wrapped and every other member (a test disk's `objects()`,
 * `multipart`, `registerAs`) passed through bound to the driver. The driver's calls to its OWN
 * methods stay unwrapped: one caller's call is one event.
 */
export function instrumentedDisk(disk: string, driver: StorageDriver): StorageDriver {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(driver, {
    get(target, property) {
      const known = wrapped.get(property);
      if (known !== undefined) return known;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      // A Proxy `get` is handed every name, `constructor` included: an own key or no verb.
      const verb =
        typeof property === 'string' && Object.hasOwn(VERB_OF, property)
          ? VERB_OF[property]
          : undefined;
      const method = value as (...args: unknown[]) => unknown;
      const bound =
        verb === undefined
          ? method.bind(target)
          : (...args: unknown[]): Promise<unknown> =>
              call(disk, verb, keyOf(property as string, args), driver.name, () =>
                Promise.resolve(method.apply(target, args)),
              );
      wrapped.set(property, bound);
      return bound;
    },
  });
}

async function call(
  disk: string,
  verb: StorageVerb,
  key: string,
  driverName: string,
  work: () => Promise<unknown>,
): Promise<unknown> {
  const name = `storage.${verb}` as const;
  const started = performance.now();
  try {
    const answer = await withSpan(name, work, {
      kind: 'client',
      attributes: { 'ultimate.storage.disk': disk, 'ultimate.storage.driver': driverName },
    });
    const bytes = bytesOf(answer);
    report(name, {
      disk,
      key,
      ...(bytes === undefined ? {} : { bytes }),
      durationMs: performance.now() - started,
    });
    return answer;
  } catch (error) {
    report(name, { disk, key, durationMs: performance.now() - started, error });
    throw error;
  }
}
