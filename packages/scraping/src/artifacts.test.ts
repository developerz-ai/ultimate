// The artifact writer's one untrusted input: the FILENAME. On a download it came off the site's
// own `Content-Disposition`, and it decides a content type that ends up on an S3 header.

import { describe, expect, test } from 'bun:test';
import type { StorageDriver } from '@ultimat3/storage';
import { contentTypeFor, createArtifactWriter, DEFAULT_CONTENT_TYPE } from './artifacts';

interface Put {
  readonly key: string;
  readonly contentType: unknown;
}

const recordingStorage = (): StorageDriver & { readonly puts: readonly Put[] } => {
  const puts: Put[] = [];
  return {
    puts,
    put: (key: string, _body: Uint8Array, options?: { readonly contentType?: string }) => {
      puts.push({ key, contentType: options?.contentType });
      return Promise.resolve({ key });
    },
  } as unknown as StorageDriver & { readonly puts: readonly Put[] };
};

describe('unit · contentTypeFor answers a string for every name a site can pick', () => {
  test('a known extension maps', () => {
    expect(contentTypeFor('page.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('SHOT.PNG')).toBe('image/png');
  });

  test('a prototype key is not a content type — it is an unknown extension', () => {
    // Executed against the object-literal lookup this replaced: `report.constructor` answered a
    // FUNCTION and `report.__proto__` an OBJECT, where the return type says `string`.
    expect(contentTypeFor('report.constructor')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor('report.__proto__')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor('report.toString')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor('report.hasOwnProperty')).toBe(DEFAULT_CONTENT_TYPE);
  });

  test('a name with no extension at all is the default', () => {
    expect(contentTypeFor('page')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor('')).toBe(DEFAULT_CONTENT_TYPE);
  });
});

describe('unit · what reaches storage.put is always a string content type', () => {
  test("a site-chosen filename cannot put a function on the object's header", async () => {
    const storage = recordingStorage();
    const writer = createArtifactWriter({ storage, scrape: 'orders', runId: 'run-1' });
    const ref = await writer.save('report.constructor', 'body');
    expect(typeof ref.contentType).toBe('string');
    expect(storage.puts).toEqual([
      { key: 'scrape/orders/run-1/report.constructor', contentType: DEFAULT_CONTENT_TYPE },
    ]);
  });

  test('an explicit content type still wins, and the key carries the run prefix', async () => {
    const storage = recordingStorage();
    const writer = createArtifactWriter({
      storage,
      scrape: 'orders',
      runId: 'run-1',
      prefix: 'forensics',
    });
    const ref = await writer.save('page.html', '<p>hi</p>', 'text/plain');
    expect(ref.key).toBe('forensics/orders/run-1/page.html');
    expect(ref.contentType).toBe('text/plain');
    expect(ref.bytes).toBe(9);
  });

  test('no storage driver is a no-op that still answers a key — never a throw', async () => {
    const writer = createArtifactWriter({ storage: undefined, scrape: 'orders', runId: 'run-1' });
    const ref = await writer.save('page.html', '<p>hi</p>');
    expect(ref.key).toBe('scrape/orders/run-1/page.html');
    expect(writer.saved).toHaveLength(1);
  });
});
