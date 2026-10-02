// The browser has ONE HTTP function and ONE socket, as a rule over a file tree: a raw `fetch(`,
// `new WebSocket(`, `new XMLHttpRequest(` or `new EventSource(` in browser-reachable code skips
// `@ultimat3/core`'s `clientTransport` — credentials, the idempotency header, the record envelope,
// the principal fence — so its rows never reach the page's store and it keeps running for the
// previous principal after a sign-out. A package's SERVER BARREL in that closure is refused too.
//
// BROWSER-REACHABLE is derived, never listed: every `*.island.tsx`, every module that names the
// client seam itself, and the import closure of each, followed name by name through barrels
// (`import-closure.ts`). Pure over the tree its caller read — `app-transport.ts` reads an app's,
// `scripts/browser-transport.ts` this repository's.
//
// WHAT IT CANNOT SEE: a browser module that neither is an island, nor names the seam, nor is
// imported by either; a request made inside an installed package (the walk ends at the package
// boundary); a fetch reached through a computed member (`globalThis['fetch']`); and a bare
// `fetch(` in a file that also binds a local `fetch` (`bindsFetch`). A floor, not a proof.

import { ERROR_DOCS_URL, maskLiterals } from '@ultimat3/core';
import { commentSafe } from './comment-safe';
import type { ClosureHost } from './import-closure';
import { importClosure } from './import-closure';
import type { Finding } from './output';
import type { BarrelImport } from './server-barrels';
import { barrelImports } from './server-barrels';
import { isTest } from './source-files';
import type { TransportCall, TransportShape } from './transport-calls';
import { transportCalls } from './transport-calls';

export interface Bypass extends TransportCall {
  readonly file: string;
}

export interface ServerBarrel extends BarrelImport {
  readonly file: string;
}

export const isIsland = (path: string): boolean => path.endsWith('.island.tsx');

/** A module naming the page's client seam is browser code by its own statement. */
const NAMES_SEAM = /\b(?:clientTransport|pageClient)\s*[(<]/;

/**
 * Where the closure starts: every island, plus every module `namesSeam` admits that calls the seam
 * itself. Masked before the test: a template that EMITS `clientTransport(` is not browser code.
 */
export function browserEntries(
  files: ReadonlyMap<string, string>,
  namesSeam: (path: string) => boolean = () => true,
): readonly string[] {
  return [...files.entries()]
    .filter(([path, source]) => {
      if (isTest(path)) return false;
      if (isIsland(path)) return true;
      // The raw text first: masking is a pass over every character, and almost no file names it.
      return namesSeam(path) && NAMES_SEAM.test(source) && NAMES_SEAM.test(maskLiterals(source));
    })
    .map(([path]) => path)
    .sort();
}

export interface TransportInput {
  readonly entries: readonly string[];
  /** Reads a file and resolves a bare specifier; `undefined` from either ends the walk there. */
  readonly host: ClosureHost;
  /**
   * Shape → the ONE file in this tree allowed to hold it. Empty for an app: the seams are the
   * framework's and live in `node_modules`, past the boundary the walk stops at.
   */
  readonly seams: ReadonlyMap<TransportShape, string>;
  /** Files whose realm is not a page — a service worker has no store and no principal fence. */
  readonly exempt?: ReadonlySet<string>;
  /** Server barrel → the browser entry that replaces it (`serverBarrels`). */
  readonly barrels: ReadonlyMap<string, string>;
  /** A package's own modules may import its own barrel; only a FOREIGN import pays for it. */
  readonly ownsBarrel?: (file: string, barrel: string) => boolean;
}

/** The whole rule over a tree, pure. */
export function checkBrowserTransport(input: TransportInput): {
  readonly reachable: readonly string[];
  readonly bypasses: readonly Bypass[];
  readonly barrels: readonly ServerBarrel[];
} {
  const reachable = importClosure(input.host, input.entries);
  const bypasses: Bypass[] = [];
  const barrels: ServerBarrel[] = [];
  for (const file of reachable) {
    if (input.exempt?.has(file) === true) continue;
    const source = input.host.read(file) ?? '';
    for (const call of transportCalls(source)) {
      if (input.seams.get(call.shape) === file) continue;
      bypasses.push({ ...call, file });
    }
    for (const found of barrelImports(source, input.barrels)) {
      if (input.ownsBarrel?.(file, found.barrel) === true) continue;
      barrels.push({ ...found, file });
    }
  }
  return { reachable, bypasses, barrels };
}

/**
 * What to write instead, per shape — each a line that runs once its placeholder is named. A raw
 * request does not say which of these it is, so `fetch` lists the four it can be.
 */
const REPLACEMENT: ReadonlyMap<TransportShape, string> = new Map([
  [
    'fetch',
    "an action: `await browserClient.<action>(input)` (rpc<Api['actions']> in apps/web/shared/browser-client.ts); a read: `useQuery(<QUERY_REF>, input)` from '@ultimat3/realtime'; a file: `await uploadFile({ file, grant })` from '@ultimat3/storage'; anything else: `await clientTransport({ method: 'GET', url })` from '@ultimat3/core/page'",
  ],
  [
    'websocket',
    "`useQuery(<QUERY_REF>, input)` for rows or `useChannel(<CHANNEL_REF>, params, { onEvent })` for events, both from '@ultimat3/realtime' — the page has one socket and it is the framework's",
  ],
  [
    'xhr',
    "an upload with progress: `await uploadFile({ file, grant, onProgress })` from '@ultimat3/storage'; anything else: `await clientTransport({ method: 'GET', url })` from '@ultimat3/core/page'",
  ],
  [
    'eventsource',
    "`useQuery(<QUERY_REF>, input)` or `useChannel(<CHANNEL_REF>, params, { onEvent })` from '@ultimat3/realtime' — pushed frames arrive on the page's one socket",
  ],
]);

export interface FindingContext {
  /** Who may hold `shape` instead — a file in a repo, the framework's function in an app. */
  readonly holder: (shape: TransportShape) => string | undefined;
  /** The command that re-reads the tree: the gate's step in an app, the script in this repo. */
  readonly rerun: string;
}

/** `file:line` for a message: the path is the scanned tree's, so it is escaped before it is quoted. */
const siteOf = (site: { readonly file: string; readonly line: number }): string =>
  `${commentSafe(site.file)}:${site.line}`;

/**
 * One runnable line, the edit behind a `#` — the shape `app-boundaries.ts` gives every fix. The
 * command re-reads the tree; the comment is the edit, because only the finding knows the line.
 */
export function bypassFinding(bypass: Bypass, context: FindingContext): Finding {
  const holder = context.holder(bypass.shape);
  const site = siteOf(bypass);
  return {
    code: 'X_BROWSER_TRANSPORT_BYPASS',
    at: `${bypass.file}:${bypass.line}`,
    cause: `${site} calls ${bypass.spelled} in browser-reachable code; ${holder === undefined ? 'no module may' : `only ${holder} may`}, so this request skips the page's record store, idempotency header and principal fence`,
    fix: `${context.rerun}   # after replacing ${bypass.spelled} at ${site} with ${REPLACEMENT.get(bypass.shape) ?? ''}`,
    docs: ERROR_DOCS_URL,
  };
}

export function barrelFinding(site: ServerBarrel, context: FindingContext): Finding {
  const at = siteOf(site);
  return {
    code: 'X_BROWSER_SERVER_BARREL',
    at: `${site.file}:${site.line}`,
    cause: `${at} imports ${site.barrel} in browser-reachable code; that barrel is the package's server half, and ${site.entry} is the entry it publishes for a browser`,
    fix: `${context.rerun}   # after changing the import at ${at} from '${site.barrel}' to '${site.entry}'`,
    docs: ERROR_DOCS_URL,
  };
}
