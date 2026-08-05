// The constants every stage of the site build shares: origin, source and output roots, and the
// fixed stylesheet and page order. Defined once here so no two stages can disagree.

export const ORIGIN = 'https://ultimate.developerz.ai';
// `..` because this module sits in site/lib/ — ROOT must still resolve to the site directory.
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const REPO_ROOT = ROOT.replace(/\/site$/, '');
export const DIST = `${ROOT}/dist`;
export const STYLE_ORDER = ['tokens', 'base', 'layout', 'components', 'syntax'] as const;
export const PAGE_ORDER = [
  'index',
  'quickstart',
  'primitives',
  'realtime',
  'jobs',
  'rendering-seo',
  'pwa-offline',
  'ai-first',
  'deploy',
  'roadmap',
  'faq',
  'changelog',
] as const;

export interface Page {
  readonly slug: string;
  readonly url: string;
  readonly file: string;
  readonly meta: Record<string, string>;
  readonly body: string;
}
