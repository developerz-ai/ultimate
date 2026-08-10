// The constants every stage of the site build shares: origin, source and output roots, the
// framework version, and the fixed stylesheet and page order. Defined once here so no two stages
// can disagree.

import { readFileSync } from 'node:fs';

export const ORIGIN = 'https://ultimate.developerz.ai';
// `..` because this module sits in site/lib/ — ROOT must still resolve to the site directory.
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const REPO_ROOT = ROOT.replace(/\/site$/, '');
export const DIST = `${ROOT}/dist`;

const CORE_PACKAGE = 'packages/core/package.json';

/** Loose on purpose: the shape of a release version, not a re-implementation of semver. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)*(?:\+[\w.]+)*$/;

/**
 * `site/` is its own bundle graph (axiom 6) and imports zero `@ultimat3/*` packages, so
 * `UltimateError` is out of reach here. The message is hand-built to the same contract instead —
 * code, cause, executable fix — because this string is the only instruction the build gives.
 */
function versionFailure(cause: string): Error {
  return new Error(
    `X_APP_PACKAGE_INVALID: ${CORE_PACKAGE} supplies no usable version\n` +
      `  cause: ${cause}\n` +
      '  fix:   cd packages/core && bun pm pkg set version=1.0.0',
  );
}

/**
 * The version the site publishes to search engines and prints in its own chrome, read from the
 * same manifest `@ultimat3/core`'s `FRAMEWORK_VERSION` reads. Hardcoding it left the JSON-LD graph
 * advertising `0.0.1` for the whole of 1.0.0 — machine-readable drift nobody sees in a browser.
 * Validated rather than cast: an unchecked `as` would publish `undefined` just as quietly.
 */
function readFrameworkVersion(): string {
  const path = `${REPO_ROOT}/${CORE_PACKAGE}`;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw versionFailure(`${path} is unreadable or is not JSON — ${String(error)}`);
  }
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw versionFailure(`its "version" field is ${JSON.stringify(version)}, not a semver string`);
  }
  return version;
}

export const FRAMEWORK_VERSION: string = readFrameworkVersion();
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

/**
 * The frontmatter vocabulary every page draws from. Declared instead of left to a bare
 * `Record<string, string>` so a key the build reads is a name the compiler knows: `meta.nav` is
 * checked, `meta.navv` is not a property. A key outside the list still parses — it just has to be
 * read by bracket, which is the compiler saying it is not part of the contract.
 */
export interface PageMeta {
  /** `<h1>`, `<title>` and the JSON-LD headline. `lib/seo.ts` fails the build without it. */
  readonly title?: string;
  /** `<meta name="description">` and the JSON-LD description. 50–160 characters, enforced. */
  readonly description?: string;
  /** Home only: the hero heading, when it should differ from `title`. */
  readonly headline?: string;
  /** The standfirst under the heading, when it should differ from `description`. */
  readonly lede?: string;
  /** The short label the breadcrumb, the header and the pager use. */
  readonly nav?: string;
  /** `'true'` opts the page into the header menu; every page is reachable regardless. */
  readonly menu?: string;
  /** `YYYY-MM-DD`, published as `sitemap.xml`'s `lastmod` and JSON-LD's `dateModified`. */
  readonly updated?: string;
  readonly [key: string]: string | undefined;
}

export interface Page {
  readonly slug: string;
  readonly url: string;
  readonly file: string;
  readonly meta: PageMeta;
  readonly body: string;
}
