// The slice of `@ultimat3/storage`'s `StorageDriver` the conformance checks call, structurally —
// as `budget-store-conformance.ts` does for `ai` — so a disk of your own is held to it without this
// package's build depending on `storage`. Every shipped disk is assignable as it is.

import type { UltimateError } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';

type Range = readonly [number, number];

export interface StorageObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

interface WriteOptions {
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** The members a disk answers through the port, and nothing a single driver adds. */
export interface StorageDriverLike {
  readonly name: string;
  put(key: string, body: Uint8Array, options?: WriteOptions): Promise<StorageObjectLike>;
  putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: WriteOptions & { readonly maxBytes: number },
  ): Promise<StorageObjectLike>;
  stat(key: string): Promise<StorageObjectLike | undefined>;
  get(
    key: string,
    options?: { readonly range?: Range | undefined },
  ): Promise<{ readonly bytes: Uint8Array; readonly object: StorageObjectLike }>;
  stream(
    key: string,
    options?: { readonly etag?: string | undefined },
  ): Promise<ReadableStream<Uint8Array>>;
  streamRange(
    key: string,
    range: Range,
    options?: { readonly etag?: string | undefined },
  ): Promise<ReadableStream<Uint8Array>>;
  copy(
    from: string,
    to: string,
    options?: { readonly ifMatch?: string | undefined },
  ): Promise<StorageObjectLike>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(options?: {
    readonly prefix?: string | undefined;
    readonly cursor?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<{
    readonly rows: readonly { readonly key: string }[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }>;
}

/**
 * What a check is handed. `maxPutBytes`, when the disk was built with one, arms the check that
 * `putStream` is bounded by its own `maxBytes` and never by the disk's buffered-write ceiling.
 */
export interface StorageSubject {
  readonly disk: StorageDriverLike;
  readonly maxPutBytes?: number | undefined;
}

export interface StorageCheck {
  readonly name: string;
  run(subject: StorageSubject): Promise<void>;
}

/** A key namespace per check, so a shared bucket survives two runs and a run that died. */
export const scopeOf = (): string => `conformance/${crypto.randomUUID()}/`;

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

export const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** What a call was refused with: its code, and the coded error itself when there was one. */
export interface Refusal {
  readonly code: string;
  readonly error?: UltimateError | undefined;
}

/** Code `resolved` when the call was not refused, so a test names the miss. */
export async function refusedWith(call: () => Promise<unknown>): Promise<Refusal> {
  try {
    await call();
  } catch (caught) {
    if (isUltimateError(caught)) return { code: caught.code, error: caught };
    return { code: `not-a-coded-error: ${String(caught)}` };
  }
  return { code: 'resolved' };
}

/** Whether the refusal's `fix` (or `cause`) names `text` — false for no coded refusal at all. */
export const names = (refusal: Refusal, field: 'fix' | 'cause', text: string): boolean =>
  refusal.error?.[field].includes(text) ?? false;

/** The code alone. */
export const refusalOf = async (call: () => Promise<unknown>): Promise<string> =>
  (await refusedWith(call)).code;
