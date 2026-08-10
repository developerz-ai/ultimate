// The constants every stage of the site build shares: origin, source and output roots, the
// framework version, and the fixed stylesheet and page order. Defined once here so no two stages
// can disagree.

import { readFileSync } from 'node:fs';

export const ORIGIN = 'https://ultimate.developerz.ai';
// `..` because this module sits in site/lib/ — ROOT must still resolve to the site directory.
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const REPO_ROOT = ROOT.replace(/\/site$/, '');
export const DIST = `${ROOT}/dist`;

/**
 * The version the site publishes to search engines, read from the same manifest
 * `@ultimat3/core`'s `FRAMEWORK_VERSION` reads. Hardcoding it left the JSON-LD graph advertising
 * `0.0.1` for the whole of 1.0.0 — machine-readable drift nobody sees in a browser. The site
 * build stays a separate bundle graph (axiom 6), so this reads the file rather than importing
 * the package.
 */
export const FRAMEWORK_VERSION: string = (
  JSON.parse(readFileSync(`${REPO_ROOT}/packages/core/package.json`, 'utf-8')) as {
    version: string;
  }
).version;
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
