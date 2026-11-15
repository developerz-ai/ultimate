// Single responsibility: a resolved disk's multipart capability, its four session-changing calls
// each reported as `storage.multipart` (`op` create | part | complete | abort) inside a client span.
// Signing a part URL and listing parts or sessions change nothing, and pass through unreported.

import type { StorageMultipartEvent } from '@ultimat3/core';
import { instrument, subscribed, withSpan } from '@ultimat3/core';
import type { MultipartCapability } from './multipart';

type MultipartOp = StorageMultipartEvent['op'];

/** The bytes the answer states: a stored part's `size`, or the assembled object's. */
const sizeOf = (answer: unknown): number | undefined =>
  typeof answer === 'object' &&
  answer !== null &&
  'size' in answer &&
  typeof answer.size === 'number'
    ? answer.size
    : undefined;

/** `capability` for the disk named `disk`, its session changes reported. The rest is its own. */
export function instrumentedMultipart(
  disk: string,
  driverName: string,
  capability: MultipartCapability,
): MultipartCapability {
  const report = async <T>(op: MultipartOp, key: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const emit = (extra: { bytes?: number; error?: unknown }): void => {
      if (!subscribed('storage.multipart')) return;
      const event: StorageMultipartEvent = {
        disk,
        key,
        op,
        durationMs: performance.now() - started,
        ...extra,
      };
      instrument('storage.multipart', event);
    };
    try {
      const answer = await withSpan('storage.multipart', work, {
        kind: 'client',
        attributes: {
          'ultimate.storage.disk': disk,
          'ultimate.storage.driver': driverName,
          'ultimate.storage.multipart.op': op,
        },
      });
      const bytes = sizeOf(answer);
      emit(bytes === undefined ? {} : { bytes });
      return answer;
    } catch (error) {
      emit({ error });
      throw error;
    }
  };
  const { receivePart } = capability;
  return {
    create: (key, options) => report('create', key, () => capability.create(key, options)),
    signPart: (...args) => capability.signPart(...args),
    listParts: (key, uploadId) => capability.listParts(key, uploadId),
    complete: (key, uploadId, parts) =>
      report('complete', key, () => capability.complete(key, uploadId, parts)),
    abort: (key, uploadId) => report('abort', key, () => capability.abort(key, uploadId)),
    listUploads: (prefix) => capability.listUploads(prefix),
    ...(receivePart === undefined
      ? {}
      : {
          receivePart: (key, uploadId, partNumber, bytes) =>
            report('part', key, () =>
              receivePart.call(capability, key, uploadId, partNumber, bytes),
            ),
        }),
  };
}
