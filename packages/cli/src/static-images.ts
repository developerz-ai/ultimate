// Single responsibility: the image variants a static export's documents promise, as FILES. While
// the export renders, `responsiveImage` asks this module for each variant's URL — `/_img/<source
// hash>-<width>.<ext>` — and after it, every URL an exported document names is decoded, resized
// and written through core's pipeline. A dumb file server then answers `image/webp` for a webp.

// why: Bun exposes no path-join primitive, and every variant path is relative to the export root.
import { join } from 'node:path';
import { canEncode, imageUnsupported, sniffImageFormat, transformImageBytes } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import type { StaticImageRequest } from '@ultimat3/seo';
import { ImageSourceUnreadableError } from './static-capture-errors';

/** Where every variant lands, and the prefix a document names it by. */
export const STATIC_IMAGE_DIR = '_img';

/** The source encodings an export can read and resize — core's decoders, minus SVG markup. */
const SOURCE_GLOB = new Bun.Glob('**/*.{png,jpg,jpeg,webp,gif}');

interface Source {
  readonly file: string;
  readonly hash: string;
  /** What the variant is written as when the document named no format. */
  readonly ownFormat: 'png' | 'jpeg' | 'webp';
}

interface Variant {
  readonly src: string;
  readonly width: number;
  /** `undefined` for a source the export does not hold: the URL is recorded, never written. */
  readonly source: Source | undefined;
  readonly format: string;
}

export interface StaticImages {
  /** The URL builder `@ultimat3/seo`'s static seam calls. Never throws: refusals wait for `write`. */
  imageUrl(request: StaticImageRequest): string;
  /**
   * Writes every recorded variant an exported document names, and answers their site paths. A
   * named variant of a `src` the export does not hold is `X_IMAGE_SOURCE_UNREADABLE`; one in a
   * format the pipeline cannot encode (`avif`) is core's `X_IMAGE_UNSUPPORTED` — a build error,
   * never a dead `<source>`. URLs only weighed documents named are never written.
   */
  write(documents: readonly string[]): Promise<readonly string[]>;
}

const EXTENSION: ReadonlyMap<string, string> = new Map([
  ['png', 'png'],
  ['jpeg', 'jpg'],
  ['webp', 'webp'],
  ['avif', 'avif'],
]);

/** The site path a `src` names, without a query or fragment — the file it is in the export. */
const pathOf = (src: string): string => src.replace(/[?#].*$/, '');

/** Index the images the export already holds (`asset()` copies, icons), by their site path. */
async function indexSources(out: string): Promise<ReadonlyMap<string, Source>> {
  const sources = new Map<string, Source>();
  for await (const relative of SOURCE_GLOB.scan({ cwd: out, onlyFiles: true })) {
    const site = `/${relative.split('\\').join('/')}`;
    if (site.startsWith(`/${STATIC_IMAGE_DIR}/`)) continue;
    const file = join(out, relative);
    const bytes = await Bun.file(file).bytes();
    const format = sniffImageFormat(bytes);
    if (format === null) continue;
    sources.set(site, {
      file,
      hash: contentHash(bytes),
      ownFormat: format === 'jpeg' || format === 'webp' ? format : 'png',
    });
  }
  return sources;
}

export async function staticImages(out: string): Promise<StaticImages> {
  const sources = await indexSources(out);
  const variants = new Map<string, Variant>();
  return {
    imageUrl({ src, width, format }) {
      const source = sources.get(pathOf(src));
      const resolved = format ?? source?.ownFormat ?? 'png';
      // A src the export lacks still gets a stable URL, so `write` can tell which document named it.
      const stem = source === undefined ? `missing-${contentHash(src)}` : source.hash;
      const url = `/${STATIC_IMAGE_DIR}/${stem}-${String(width)}.${EXTENSION.get(resolved) ?? resolved}`;
      variants.set(url, { src, width, source, format: resolved });
      return url;
    },
    async write(documents) {
      const named = [...variants].filter(([url]) => documents.some((html) => html.includes(url)));
      const missing = [
        ...new Set(named.filter(([, one]) => one.source === undefined).map(([, one]) => one.src)),
      ];
      if (missing.length > 0) throw new ImageSourceUnreadableError(missing);
      const refused = named.find(([, one]) => !canEncode(one.format));
      if (refused !== undefined) {
        throw imageUnsupported(
          `a static page asked responsiveImage() for ${refused[1].format}, which the build pipeline cannot encode, so its <source> would name a file no build writes`,
          "responsiveImage(input, { formats: ['webp'] })   # drop avif from a static route; a CDN driver serves it at runtime",
          { format: refused[1].format, src: refused[1].src },
        );
      }
      const written: string[] = [];
      for (const [url, one] of named) {
        if (one.source === undefined || !canEncode(one.format)) continue;
        const bytes = await transformImageBytes(await Bun.file(one.source.file).bytes(), {
          width: one.width,
          format: one.format,
        });
        await Bun.write(join(out, url.slice(1)), bytes);
        written.push(url);
      }
      return written;
    },
  };
}
