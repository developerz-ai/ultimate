// The docs corpus, read once per process from this repository's `wiki/` — the one source the
// GitHub wiki also mirrors. Build-time only: every route that calls it is `render: 'static'`, so a
// visitor's request never reads a file. Every declared `X_*` code is held to a page here.

import {
  assertCodePages,
  type CodePiece,
  type DocPiece,
  type DocsCorpus,
  readCorpus,
} from '@docs-site/docs-source';
import { assertCoded, retryMemo } from '@ultimat3/core';
import { MARKDOWN_MAX_CHARS } from '@ultimat3/ui';
import { FOOTER_ANCHOR } from './docs-links';

/** The repository root: this app is `dummy/docs-site`, and this file `apps/web/shared/docs.ts`. */
const REPO = new URL('../../../../../', import.meta.url);

/**
 * The largest body `Markdown` parses before the rest falls back to plain text — `@ultimat3/ui`'s
 * `MARKDOWN_MAX_CHARS`. A piece past it is refused by the reader (`X_DOCS_PIECE_OVERSIZE`), so
 * the site never prints a page as text.
 */
export const RENDER_CAP_CHARS = MARKDOWN_MAX_CHARS;

interface FrameworkManifest {
  readonly errorCodes: readonly { readonly code: string }[];
}

const isManifest = (value: unknown): value is FrameworkManifest =>
  typeof value === 'object' &&
  value !== null &&
  'errorCodes' in value &&
  Array.isArray(value.errorCodes);

async function load(): Promise<DocsCorpus> {
  const dir = Bun.fileURLToPath(new URL('wiki/', REPO));
  const names = await Array.fromAsync(new Bun.Glob('*.md').scan({ cwd: dir }));
  const files = await Promise.all(
    names.sort().map(async (file) => ({ file, markdown: await Bun.file(`${dir}/${file}`).text() })),
  );
  const corpus = readCorpus(files, { maxChars: RENDER_CAP_CHARS, footer: FOOTER_ANCHOR });
  const manifest: unknown = await Bun.file(new URL('framework.manifest.json', REPO)).json();
  assertCoded(
    isManifest(manifest),
    'X_INVARIANT',
    'framework.manifest.json carries no errorCodes list, so no code can be proven to have a page',
    'cd ../.. && bun run manifest   # regenerates framework.manifest.json, then rebuild this site',
  );
  assertCodePages(
    manifest.errorCodes.map((one) => one.code),
    corpus,
  );
  return corpus;
}

/**
 * A reader, memoised by `retryMemo` rather than `??=`: a read that rejected (one transient read
 * failure) is not kept as the answer for the life of the process. Injected for the test.
 */
export const corpusReader = (read: () => Promise<DocsCorpus>): (() => Promise<DocsCorpus>) => {
  const corpus = retryMemo(read);
  return () => corpus.get();
};

/** The corpus, read on the first call and shared by every route after it. */
export const docsCorpus = corpusReader(load);

/** The page at a site path, or `undefined`: a static route answers 404 for a path it never built. */
export async function docPage(url: string): Promise<DocPiece | undefined> {
  const { pages, majors } = await docsCorpus();
  return [...pages, ...majors].find((piece) => piece.url === url);
}

export async function codePage(code: string): Promise<CodePiece | undefined> {
  return (await docsCorpus()).codes.find((piece) => piece.code === code);
}
