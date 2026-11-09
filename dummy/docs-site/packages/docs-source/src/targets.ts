// What a link target written in the wiki points at: a wiki page (and maybe a heading on it), or
// somewhere this site does not own. GitHub's wiki resolves `[x](Getting-Started)` against itself;
// the site has to say which of its own URLs that is.

/** A link into the wiki: the page's name as its file is named, and the anchor if any. */
export interface WikiTarget {
  readonly page: string;
  readonly anchor: string | undefined;
}

const REPO = 'https://github.com/developerz-ai/ultimate';
/** `Getting-Started`, `Getting-Started.md`, `_Footer`, each with an optional `#anchor`. */
const BARE = /^(_?[A-Z0-9][A-Za-z0-9-]*)(?:\.md)?(?:#(.*))?$/;
const WIKI_URL = new RegExp(`^${RegExp.escape(`${REPO}/wiki/`)}([^#/]+)(?:#(.*))?$`);
const BLOB_URL = new RegExp(`^${RegExp.escape(`${REPO}/blob/main/wiki/`)}([^#/]+)\\.md(?:#(.*))?$`);

const anchorOf = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.length === 0 ? undefined : decodeURIComponent(raw);

/**
 * The wiki page a target names, `undefined` for anything else (another site, a repository file, a
 * mail address). A same-page `#anchor` names `page`.
 */
export function wikiTarget(target: string, page: string): WikiTarget | undefined {
  if (target.startsWith('#')) return { page, anchor: anchorOf(target.slice(1)) };
  const match = BARE.exec(target) ?? WIKI_URL.exec(target) ?? BLOB_URL.exec(target);
  if (match === null) return undefined;
  return { page: match[1] ?? '', anchor: anchorOf(match[2]) };
}

/** `Getting-Started.md` → `Getting-Started`; `undefined` for anything not a page of the wiki. */
export const pageOfFile = (file: string): string | undefined =>
  file.endsWith('.md') && !file.startsWith('_') ? file.slice(0, -'.md'.length) : undefined;

/** The page's site path: `Getting-Started` → `/getting-started`. `Home` is the manual's front. */
export const pageUrl = (page: string): string =>
  page === 'Home' ? '/docs' : `/${page.toLowerCase()}`;
