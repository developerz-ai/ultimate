// Single responsibility: the request ceiling of a disk whose signed PUT lands on THIS process (local,
// memory). One request cannot carry more than the server reads in one, so a single-request grant
// past it is refused when it is signed — the fix names the multipart grant, whose parts each fit.

import { finiteCount } from '@ultimat3/core';
import { StorageError } from './errors';

/** A number, or a reader of one: a host whose ceiling is declared after the disk is built. */
export type RequestCeiling = number | (() => number);

/**
 * Screened where it is declared, as every byte ceiling is; a reader is screened each time it is
 * read, at signing. The answer is `undefined` for "no ceiling declared".
 */
export const screenRequestCeiling = (
  driver: string,
  value: RequestCeiling | undefined,
): (() => number | undefined) => {
  const screen = (bytes: number): number =>
    finiteCount(`the ${driver} disk driver`, 'maxRequestBytes', bytes, 1);
  if (value === undefined) return () => undefined;
  if (typeof value === 'function') return () => screen(value());
  const fixed = screen(value);
  return () => fixed;
};

/** A single-request PUT URL bound past what one request may carry. A part URL is never refused. */
export function assertWithinRequestCeiling(
  driver: string,
  ceiling: number | undefined,
  url: {
    readonly method?: string | undefined;
    readonly part?: unknown;
    readonly bound: number | undefined;
  },
): void {
  if (ceiling === undefined || url.part !== undefined || url.method !== 'PUT') return;
  if (url.bound === undefined || url.bound <= ceiling) return;
  throw new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `a single signed PUT of up to ${url.bound}B on the ${driver} disk is one request to this server, whose ceiling is ${ceiling}B (http.maxRequestBodyBytes)`,
    fix: 'await grantMultipart({ disk, orgId, request, policy })   # parts, each one request under the ceiling — then signPart and completeUpload',
    meta: { driver, bytes: url.bound, maxBytes: ceiling },
  });
}
