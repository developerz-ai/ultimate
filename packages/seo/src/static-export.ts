// The seam a static export installs while it renders: where an image variant and a captured social
// card live as FILES. Absent at serve time, so a served document never pays for it — and a dumb
// file server ignores `?w=&f=`, which is why the export cannot use the query URLs the media route
// answers. The exporter owns the files; this package only asks it for their URLs.

import type { OpenGraphImage } from './meta';

/** One variant a document asked for: `format` undefined is the source's own encoding. */
export interface StaticImageRequest {
  readonly src: string;
  readonly width: number;
  readonly format: string | undefined;
}

export interface StaticExport {
  /** The site path one variant is written at, e.g. `/_img/3f2a1b9c-640.webp`. Records it. */
  imageUrl(request: StaticImageRequest): string;
  /** The `og:image` a declared `og.capture` is published as. Records the capture. */
  cardImage(capturePath: string): OpenGraphImage;
}

/**
 * Registered globally, like render's asset table, so two copies of this module — the app's and the
 * CLI's, resolved through different `node_modules` — read the seam the one export installed.
 */
const SLOT: unique symbol = Symbol.for('ultimate.seo.staticExport') as never;

interface Holder {
  [SLOT]?: StaticExport | undefined;
}

const holder = globalThis as unknown as Holder;

/** Installed by the static export around its renders; `undefined` uninstalls. */
export function setStaticExport(exported: StaticExport | undefined): void {
  holder[SLOT] = exported;
}

/** The installed export, or `undefined` — always `undefined` in a served process. */
export function currentStaticExport(): StaticExport | undefined {
  return holder[SLOT];
}

/**
 * A `src` the export reads from its own tree: a site path. A remote URL (`https:`, `//`) or an
 * inline `data:` image is somebody else's bytes, and keeps the query URL a CDN may answer.
 */
export const isExportableSrc = (src: string): boolean =>
  src.startsWith('/') && !src.startsWith('//');
