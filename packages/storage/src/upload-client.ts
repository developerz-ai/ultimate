// Single responsibility: the browser half of one upload — ask the server for a grant, PUT the
// bytes at it, hand back the storage key. Browser-safe by construction: no `Bun.*`, no `node:`,
// no driver import, so this file bundles into the client the way `@ultimat3/action`'s does.
//
// The default transport is `XMLHttpRequest`, not `fetch`, for exactly one reason: `fetch` reports
// no upload progress in any shipping browser, and a progress bar that jumps 0 -> 100 is a
// progress bar that is lying. `fetch` is the fallback where XHR does not exist.

import { tooLarge, uploadFailed } from './errors';
import type { UploadGrant, UploadRequest } from './grant';

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
  /** 0..1, and 0 when the total is unknown — never NaN, which formats as "NaN%". */
  readonly ratio: number;
}

/** Structural `File`: what an `<input type="file">` hands over, with no DOM lib in the contract. */
export interface UploadSource extends Blob {
  readonly name: string;
}

export interface SignedPutInput {
  readonly url: string;
  readonly contentType: string;
  readonly body: Blob;
  readonly onProgress?: ((progress: UploadProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The seam a test injects and a non-browser host replaces. Resolves only on a 2xx. */
export type SignedPut = (input: SignedPutInput) => Promise<void>;

const progressOf = (loaded: number, total: number): UploadProgress => ({
  loaded,
  total,
  ratio: total > 0 ? Math.min(loaded / total, 1) : 0,
});

/** The path without the query — a signed URL's parameters carry the HMAC, so they never log. */
const pathOf = (url: string): string => {
  try {
    return new URL(url, 'http://storage.invalid').pathname;
  } catch {
    return url;
  }
};

const aborted = (url: string): ReturnType<typeof uploadFailed> =>
  uploadFailed(pathOf(url), 0, 'the upload was aborted');

export const xhrSignedPut: SignedPut = (input) =>
  new Promise<void>((resolve, reject) => {
    // Asked BEFORE anything is opened: per spec, adding an `abort` listener to a signal that has
    // already aborted never fires it, so the whole body used to go up for a caller who had already
    // given up — the one case the listener below cannot cover.
    if (input.signal?.aborted === true) {
      reject(aborted(input.url));
      return;
    }

    const request = new XMLHttpRequest();
    const onAbortRequested = (): void => {
      request.abort();
    };
    /**
     * Every terminal outcome releases the signal listener. An `AbortSignal` is normally one per
     * picker session and an upload is one per file, so a listener that is only ever added left one
     * behind per call for the life of the signal — and each one retains its `XMLHttpRequest`.
     */
    const settle =
      (answer: () => void): (() => void) =>
      () => {
        input.signal?.removeEventListener('abort', onAbortRequested);
        answer();
      };

    request.open('PUT', input.url, true);
    request.setRequestHeader('content-type', input.contentType);
    request.upload.addEventListener('progress', (event: ProgressEvent) => {
      input.onProgress?.(progressOf(event.loaded, event.lengthComputable ? event.total : 0));
    });
    request.addEventListener(
      'load',
      settle(() => {
        if (request.status >= 200 && request.status < 300) {
          input.onProgress?.(progressOf(input.body.size, input.body.size));
          resolve();
          return;
        }
        reject(uploadFailed(pathOf(input.url), request.status, request.responseText));
      }),
    );
    // A transport fault carries no status; 0 is the one value no server can answer with.
    request.addEventListener(
      'error',
      settle(() => {
        reject(uploadFailed(pathOf(input.url), 0, 'the request never reached the disk'));
      }),
    );
    request.addEventListener(
      'abort',
      settle(() => {
        reject(aborted(input.url));
      }),
    );
    input.signal?.addEventListener('abort', onAbortRequested);
    request.send(input.body);
  });

/** No upload progress — `onProgress` fires once at 0 and once at 1, and says so by doing that. */
export const fetchSignedPut: SignedPut = async (input) => {
  input.onProgress?.(progressOf(0, input.body.size));
  const response = await fetch(input.url, {
    method: 'PUT',
    headers: { 'content-type': input.contentType },
    body: input.body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw uploadFailed(pathOf(input.url), response.status, await response.text());
  }
  input.onProgress?.(progressOf(input.body.size, input.body.size));
};

export const defaultSignedPut = (): SignedPut =>
  typeof XMLHttpRequest === 'undefined' ? fetchSignedPut : xhrSignedPut;

export interface UploadFileInput {
  readonly file: UploadSource;
  /**
   * The app's own grant call — the typed client of the `action` that wraps `grantUpload`. Passed
   * in rather than fetched from a convention path: the policy behind it is the app's, and this
   * package has no way to know which route it was projected onto.
   */
  readonly grant: (request: UploadRequest) => Promise<UploadGrant>;
  readonly onProgress?: ((progress: UploadProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly put?: SignedPut | undefined;
}

export interface UploadedFile {
  /** What the app stores on the row. The URL is a capability and is deliberately not returned. */
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
}

/**
 * One file, one round trip each way. The size is re-checked against the grant before a byte
 * moves — the server enforces it again on arrival, and this only spares the user a full upload
 * that was always going to be refused.
 */
export async function uploadFile(input: UploadFileInput): Promise<UploadedFile> {
  const grant = await input.grant({
    filename: input.file.name,
    contentType: input.file.type,
    size: input.file.size,
  });
  if (input.file.size > grant.maxBytes) {
    throw tooLarge(grant.key, input.file.size, grant.maxBytes);
  }
  await (input.put ?? defaultSignedPut())({
    url: grant.url,
    contentType: grant.contentType,
    body: input.file,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { key: grant.key, contentType: grant.contentType, size: input.file.size };
}
