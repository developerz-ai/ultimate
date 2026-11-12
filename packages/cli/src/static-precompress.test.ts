// A static export's `.br`/`.gz` siblings: each decodes to exactly its source, is written only when
// it is smaller, and never for a file under the floor — what nginx's `brotli_static`/`gzip_static`
// or Caddy's `precompressed` serves with no coder of its own.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
// why: Bun has no native brotli decoder outside a stream; the test reads the sibling back.
import { brotliDecompressSync } from 'node:zlib';
import { STATIC_PRECOMPRESS_MIN_BYTES, writePrecompressed } from './static-precompress';

let out = '';
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'x-static-precompress-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

const CSS = '.panel{color:rgb(var(--color-fg)/1);padding:var(--space-4)}\n'.repeat(200);

describe('unit · static export siblings', () => {
  test('a stylesheet gets .br and .gz, each decoding to its source and smaller than it', async () => {
    await Bun.write(join(out, 'styles/abc.css'), CSS);
    expect(await writePrecompressed(out, ['/styles/abc.css'])).toBe(2);
    const source = new TextEncoder().encode(CSS);
    const br = await Bun.file(join(out, 'styles/abc.css.br')).bytes();
    const gz = await Bun.file(join(out, 'styles/abc.css.gz')).bytes();
    expect(new TextDecoder().decode(brotliDecompressSync(br))).toBe(CSS);
    expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(CSS);
    expect(br.byteLength).toBeLessThan(source.byteLength);
    // Brotli 11 beats gzip 9 on text: the point of writing both.
    expect(br.byteLength).toBeLessThan(gz.byteLength);
  });

  test('under the floor, no sibling: framing would eat the saving', async () => {
    await Bun.write(join(out, 'islands/a.js'), 'x'.repeat(STATIC_PRECOMPRESS_MIN_BYTES - 1));
    expect(await writePrecompressed(out, ['/islands/a.js'])).toBe(0);
    expect(await Bun.file(join(out, 'islands/a.js.br')).exists()).toBe(false);
    expect(await Bun.file(join(out, 'islands/a.js.gz')).exists()).toBe(false);
  });

  test('bytes that do not compress get no sibling larger than themselves', async () => {
    const noise = crypto.getRandomValues(new Uint8Array(4_096));
    await Bun.write(join(out, 'islands/noise.js'), noise);
    expect(await writePrecompressed(out, ['/islands/noise.js'])).toBe(0);
    expect(await Bun.file(join(out, 'islands/noise.js.gz')).exists()).toBe(false);
  });
});
