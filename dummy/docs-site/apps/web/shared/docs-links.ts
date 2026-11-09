// The site's fixed addresses, named once: the routes link to them, the reader rewrites wiki links
// to them, and the build writes the files they name.

/** Where the GitHub wiki's `_Footer` lands: the layout's own footer. */
export const FOOTER_ANCHOR = '#footer';

/** The static search index `prerender.ts` writes and the search island fetches. */
export const SEARCH_INDEX_PATH = '/search-index.json';

/** The wiki file a page came from, on GitHub: where an edit to it is made. */
export const wikiSourceUrl = (file: string): string =>
  `https://github.com/developerz-ai/ultimate/blob/main/wiki/${file}`;
