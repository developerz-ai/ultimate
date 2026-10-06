// How the budget measurer READS an emitted document: which tags are code, which attribute names an
// island entry, which path a URL is fetched at, and which files a module makes the browser load.
// Split from `budgets.ts`, which decides what of that is charged and compares it to the budget.

import { SPECULATION_RULES_TYPE } from '@ultimat3/render';

export const SCRIPT_TAG = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g;
export const SRC_ATTR = /\ssrc="(?<src>[^"]*)"/;
const TYPE_ATTR = /\stype="(?<type>[^"]*)"/;

/**
 * `application/ld+json`, `application/json`, any `…+json`: the body is data, not code — the rule
 * `@ultimat3/render`'s `head.ts` already states, restated because its `carriesJson` reads a
 * `HeadTag` and is not exported, and this side has an attribute string off the emitted document.
 * Without it a page shipping only `meta.ld` structured data and island props measured 8kb of JS
 * and failed a 2kb budget with a `fix:` naming an import chain that does not exist.
 */
export const carriesJson = (attrs: string): boolean => {
  // Everything from the first `;` is a MIME PARAMETER and not the type: a real document writes
  // `type="application/ld+json; charset=utf-8"`, which does not END with `json`, so the suffix
  // test alone charged an SEO structured-data block as executable JavaScript all over again.
  const [type = ''] = (TYPE_ATTR.exec(attrs)?.groups?.['type'] ?? '').split(';');
  const declared = type.trim().toLowerCase();
  // Speculation rules are JSON under a type that does not say so: read by the browser's
  // prefetcher, never executed — the one script a 0kb page may carry for free.
  return declared.endsWith('json') || declared === SPECULATION_RULES_TYPE;
};

/**
 * An island's chunk is reached by `import()` from inside the hydration runtime, so it never appears
 * as a `<script src>` — and a document weighed by script tags alone was charged for the runtime and
 * never for the code that runtime boots. The entry attribute is that module URL, so it is read as
 * exactly what it is: a file the browser will execute.
 */
export const ENTRY_ATTR = /\sdata-x-entry="(?<url>[^"]*)"/g;

/**
 * Static imports and `import()` both. A chunk reached by `import()` was INLINED into its island
 * before islands were split, so charging it keeps a route's number what it was; and it is fetched
 * the moment the island needs it, which is before the page does what it was loaded for.
 */
const LOADS: ReadonlySet<string> = new Set(['import-statement', 'dynamic-import']);

/** The origin every artifact path is resolved against — a name that can never be a real host. */
const ARTIFACT_ORIGIN = 'https://artifact.invalid';

/**
 * The path a browser fetches for a root-relative `url`, or `undefined` for one that is not this
 * artifact's. Resolved with the WHATWG parser, the browser's own: it reads `\` as `/`, folds `.`
 * and `..`, drops a query, and makes `//host/a.js` another origin. The dedupe below is keyed by
 * this, because it is the FETCH that is counted once, and a raw string kept two spellings of one
 * file apart — which `join` on Windows then turned back into one real path, charged twice.
 */
export function artifactPath(url: string): string | undefined {
  if (!url.startsWith('/')) return undefined;
  const resolved = URL.parse(url, ARTIFACT_ORIGIN);
  return resolved?.origin === ARTIFACT_ORIGIN ? resolved.pathname : undefined;
}

/** Same-origin paths `code`, served at `url`, makes the browser load. Cross-origin and bare are not this build's. */
export function loadedBy(url: string, code: string): readonly string[] {
  let imports: readonly { readonly path: string; readonly kind: string }[];
  try {
    imports = new Bun.Transpiler({ loader: 'js' }).scanImports(code);
  } catch {
    // A file that does not parse as JavaScript imports nothing this gate can name; its own bytes
    // are already charged.
    return [];
  }
  const base = new URL(url, ARTIFACT_ORIGIN);
  return imports
    .filter((one) => LOADS.has(one.kind) && /^\.{0,2}\//.test(one.path))
    .map((one) => new URL(one.path, base))
    .filter((target) => target.origin === base.origin)
    .map((target) => target.pathname);
}
