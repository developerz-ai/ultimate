// The `.br` and `.gz` siblings a static export writes beside each immutable asset — every island
// chunk and surface stylesheet — so a static host serves them coded with no CPU per hit. The coders
// are `@ultimat3/http`'s `PRECODERS` (brotli 11, gzip 9): the bytes the served process precodes.

// why: Bun exposes no path-join primitive; the URL is joined onto the export directory.
import { join } from 'node:path';
import { PRECODERS } from '@ultimat3/http';

/** The codings a static host reads siblings for, with the suffix each is written under. */
export const STATIC_PRECODINGS = [
  { coding: 'br', suffix: '.br' },
  { coding: 'gzip', suffix: '.gz' },
] as const;

/**
 * Below this a coding's framing eats what it saves — `COMPRESS_MIN_BYTES`' reason, and its value:
 * the served process codes nothing under 1 KiB either, so the export does not pretend to.
 */
export const STATIC_PRECOMPRESS_MIN_BYTES = 1_024;

/** The URLs a static export writes that are named by their bytes: every chunk, every sheet. */
export const immutableUrls = (
  islands: { readonly chunks: readonly HasUrl[]; readonly shared: readonly HasUrl[] },
  styles: { readonly chunks: readonly HasUrl[] },
): readonly string[] => [...islands.chunks, ...islands.shared, ...styles.chunks].map((c) => c.url);

interface HasUrl {
  readonly url: string;
}

const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);

/**
 * Each URL's file under `out`, coded into its siblings — the file itself is already there. All at
 * once: the coders run on the thread pool, so a build with 40 chunks waits for the slowest. A
 * sibling no smaller than its source is not written: a host would serve more bytes, not fewer.
 */
export async function writePrecompressed(out: string, urls: readonly string[]): Promise<number> {
  const counts = await Promise.all(
    urls.map(async (url) => {
      const path = join(out, url.slice(1));
      const bytes = plain(await Bun.file(path).bytes());
      if (bytes.byteLength < STATIC_PRECOMPRESS_MIN_BYTES) return 0;
      const coded = await Promise.all(
        STATIC_PRECODINGS.map(async ({ coding, suffix }) => {
          const body = await PRECODERS[coding](bytes);
          if (body.byteLength >= bytes.byteLength) return 0;
          await Bun.write(`${path}${suffix}`, body);
          return 1;
        }),
      );
      return coded.reduce<number>((sum, one) => sum + one, 0);
    }),
  );
  return counts.reduce<number>((sum, one) => sum + one, 0);
}
