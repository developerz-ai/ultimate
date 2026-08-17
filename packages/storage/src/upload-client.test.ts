// The browser half. The transport is injected, never real: the test preload seals the network,
// and a helper that only works against a live socket is a helper nobody can regression-test.

import { describe, expect, test } from 'bun:test';
import { isStorageError, uploadFailed } from './errors';
import type { UploadGrant, UploadRequest } from './grant';
import type { SignedPutInput, UploadProgress, UploadSource } from './upload-client';
import { uploadFile, xhrSignedPut } from './upload-client';

const GRANT: UploadGrant = {
  key: 'org/org-1/pending/u-1.png',
  url: '/_storage/local/org/org-1/pending/u-1.png?x-sig=abc',
  method: 'PUT',
  contentType: 'image/png',
  maxBytes: 1024,
  expiresAt: 1_784_000_000_000,
};

const fileOf = (bytes: number, name = 'holiday.png', type = 'image/png'): UploadSource =>
  Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name }) as UploadSource;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

describe('uploadFile', () => {
  test('asks for a grant, PUTs at it, and answers with the key — never the URL', async () => {
    const seen: (UploadRequest | SignedPutInput)[] = [];
    const result = await uploadFile({
      file: fileOf(64),
      grant: async (request) => {
        seen.push(request);
        return GRANT;
      },
      put: async (input) => {
        seen.push(input);
      },
    });
    expect(seen[0]).toEqual({ filename: 'holiday.png', contentType: 'image/png', size: 64 });
    expect((seen[1] as SignedPutInput).url).toBe(GRANT.url);
    // The type sent is the one the SIGNATURE covers, not the one the browser guessed.
    expect((seen[1] as SignedPutInput).contentType).toBe('image/png');
    expect(result).toEqual({ key: GRANT.key, contentType: 'image/png', size: 64 });
    expect(Object.keys(result)).not.toContain('url');
  });

  // The server counts the bytes again on arrival; this only spares the user the whole transfer.
  test('refuses a file over the grant before a byte moves', async () => {
    let put = 0;
    const code = await codeOf(() =>
      uploadFile({
        file: fileOf(4096),
        grant: async () => GRANT,
        put: async () => {
          put += 1;
        },
      }),
    );
    expect(code).toBe('X_STORAGE_TOO_LARGE');
    expect(put).toBe(0);
  });

  test('a refused PUT surfaces as X_STORAGE_UPLOAD_FAILED, not a bare rejection', async () => {
    const code = await codeOf(() =>
      uploadFile({
        file: fileOf(64),
        grant: async () => GRANT,
        put: async () => {
          throw uploadFailed('/_storage/local/org/org-1/pending/u-1.png', 413, 'too large');
        },
      }),
    );
    expect(code).toBe('X_STORAGE_UPLOAD_FAILED');
  });

  test('progress reaches the caller unchanged', async () => {
    const ticks: UploadProgress[] = [];
    await uploadFile({
      file: fileOf(100),
      grant: async () => GRANT,
      onProgress: (progress) => ticks.push(progress),
      put: async (input) => {
        input.onProgress?.({ loaded: 50, total: 100, ratio: 0.5 });
        input.onProgress?.({ loaded: 100, total: 100, ratio: 1 });
      },
    });
    expect(ticks.map((tick) => tick.ratio)).toEqual([0.5, 1]);
  });
});

/**
 * The XHR transport, against a fake `XMLHttpRequest`. Bun has none, which is exactly why this half
 * shipped untested — and both defects here are things only a test with a real `AbortSignal` sees.
 */
class FakeXhr {
  static built: FakeXhr[] = [];
  static sends = 0;

  status = 200;
  responseText = '';
  aborted = false;
  readonly upload = { addEventListener: (): void => undefined };
  private readonly listeners = new Map<string, () => void>();

  constructor() {
    FakeXhr.built.push(this);
  }

  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, handler);
  }
  send(): void {
    FakeXhr.sends += 1;
  }
  abort(): void {
    this.aborted = true;
    this.fire('abort');
  }
  fire(type: string): void {
    this.listeners.get(type)?.();
  }
}

/** A real `AbortSignal` that counts what was hung on it — the leak is invisible any other way. */
function countingSignal(): {
  signal: AbortSignal;
  controller: AbortController;
  counts: { added: number; removed: number };
} {
  const controller = new AbortController();
  const { signal } = controller;
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    value: (...args: Parameters<typeof add>) => {
      counts.added += 1;
      return add(...args);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    value: (...args: Parameters<typeof remove>) => {
      counts.removed += 1;
      return remove(...args);
    },
  });
  return { signal, controller, counts };
}

describe('xhrSignedPut', () => {
  const withFakeXhr = async (run: () => Promise<void>): Promise<void> => {
    const globals = globalThis as { XMLHttpRequest?: unknown };
    const original = globals.XMLHttpRequest;
    globals.XMLHttpRequest = FakeXhr;
    FakeXhr.built = [];
    FakeXhr.sends = 0;
    try {
      await run();
    } finally {
      if (original === undefined) delete globals.XMLHttpRequest;
      else globals.XMLHttpRequest = original;
    }
  };

  const put = (signal: AbortSignal): Promise<void> =>
    xhrSignedPut({
      url: GRANT.url,
      contentType: GRANT.contentType,
      body: fileOf(4),
      signal,
    });

  // Per spec, adding an `abort` listener to an ALREADY-aborted signal never fires it — so the
  // whole body went up for a caller who had already given up.
  test('an already-aborted signal refuses before a byte is sent', async () => {
    await withFakeXhr(async () => {
      const controller = new AbortController();
      controller.abort();

      expect(await codeOf(() => put(controller.signal))).toBe('X_STORAGE_UPLOAD_FAILED');
      expect(FakeXhr.sends).toBe(0);
    });
  });

  // One `AbortSignal` per picker session, one upload per file: the listener was never removed, so
  // every completed upload left one behind for the signal's whole life.
  test('a reused signal ends with no listener left behind', async () => {
    await withFakeXhr(async () => {
      const { signal, counts } = countingSignal();

      for (let i = 0; i < 3; i += 1) {
        const settled = put(signal);
        FakeXhr.built[i]?.fire('load');
        await settled;
      }

      expect(counts.added).toBe(3);
      expect(counts.removed).toBe(3);
    });
  });

  test('a failure path releases the listener too', async () => {
    await withFakeXhr(async () => {
      const { signal, counts } = countingSignal();

      const settled = put(signal);
      FakeXhr.built[0]?.fire('error');
      expect(await codeOf(() => settled)).toBe('X_STORAGE_UPLOAD_FAILED');

      expect(counts.removed).toBe(counts.added);
    });
  });

  test('aborting mid-flight still aborts the request', async () => {
    await withFakeXhr(async () => {
      const { signal, controller, counts } = countingSignal();

      const settled = put(signal);
      controller.abort();

      expect(await codeOf(() => settled)).toBe('X_STORAGE_UPLOAD_FAILED');
      expect(FakeXhr.built[0]?.aborted).toBe(true);
      expect(counts.removed).toBe(counts.added);
    });
  });
});
