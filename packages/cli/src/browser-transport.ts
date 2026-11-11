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
//
// The global `fetch` PASSED ON — `rpc({ fetch })`, `const f = window.fetch` — is the same bypass
// one module later (`transport-values.ts`), reported with a fix that removes the hand-off.

import { ERROR_DOCS_URL, maskLiterals } from '@ultimat3/core';
import { importChain, namesFrom } from './browser-import-chain';
import { commentSafe } from './comment-safe';
import type { ClosureHost } from './import-closure';
import { importClosure } from './import-closure';
import type { Finding } from './output';
import type { BarrelImport } from './server-barrels';
import { barrelImports } from './server-barrels';
import { isTest } from './source-files';
import type { TransportCall, TransportShape } from './transport-calls';
import { transportCalls } from './transport-calls';
import { fetchValues } from './transport-values';

export interface Bypass extends TransportCall {
  readonly file: string;
  /** The global handed on as a value rather than called here (`transport-values.ts`). */
  readonly passed?: boolean;
}

export interface ServerBarrel extends BarrelImport {
  readonly file: string;
  /** The browser entry that reaches `file`, first, and `file` last: `[file]` when it IS the entry. */
  readonly chain: readonly string[];
  /** The import in `chain[0]` that starts the chain — the edge a cut deletes. */
  readonly hop?: { readonly spec: string; readonly line: number };
  /** What `file` takes from the barrel; `'*'` is the whole module. */
  readonly names: readonly string[] | '*';
  /**
   * The edit is the swap to the browser entry, at `file` — else the cut of the entry's first hop.
   * A swap only when the entry publishes every name taken; unread, only when `file` IS the entry.
   */
  readonly swaps: boolean;
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
  /**
   * Browser entry → every name it exports, where the caller could read it. A swap promised without
   * it compiles only by luck: `entity()` is in the barrel and not in `@ultimat3/entity/record`.
   */
  readonly published?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The whole rule over a tree, pure. */
export function checkBrowserTransport(input: TransportInput): {
  readonly reachable: readonly string[];
  readonly bypasses: readonly Bypass[];
  readonly barrels: readonly ServerBarrel[];
} {
  const reachable = importClosure(input.host, input.entries);
  const bypasses: Bypass[] = [];
  for (const file of reachable) {
    if (input.exempt?.has(file) === true) continue;
    const source = input.host.read(file) ?? '';
    for (const call of transportCalls(source)) {
      if (input.seams.get(call.shape) === file) continue;
      bypasses.push({ ...call, file });
    }
    for (const value of fetchValues(source)) {
      if (input.seams.get(value.shape) === file) continue;
      bypasses.push({ ...value, file, passed: true });
    }
  }
  return { reachable, bypasses, barrels: serverBarrelSites(input) };
}

/**
 * Per ENTRY, never per tree: a barrel three hops below two islands is two mistakes, one in each
 * island, and a finding that names only the module it landed in blames a file nobody edited.
 */
function serverBarrelSites(input: TransportInput): readonly ServerBarrel[] {
  const barrels: ServerBarrel[] = [];
  for (const entry of input.entries) {
    for (const file of importClosure(input.host, [entry])) {
      if (input.exempt?.has(file) === true) continue;
      const source = input.host.read(file) ?? '';
      for (const found of barrelImports(source, input.barrels)) {
        if (input.ownsBarrel?.(file, found.barrel) === true) continue;
        const path = importChain(input.host, entry, file) ?? { chain: [entry, file] };
        const names = namesFrom(source, found.barrel);
        const published = input.published?.get(found.entry);
        const swaps =
          published === undefined
            ? entry === file
            : names !== '*' && names.every((name) => published.has(name));
        barrels.push({ ...found, file, ...path, names, swaps });
      }
    }
  }
  return barrels;
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
 * The edit first, the re-read after: a line pasted before it is read must not re-run the failure
 * unchanged (`fix-sequence.ts`). Only the finding knows the line, so it names it.
 */
export function bypassFinding(bypass: Bypass, context: FindingContext): Finding {
  if (bypass.passed === true) return passedFinding(bypass, context);
  const holder = context.holder(bypass.shape);
  const site = siteOf(bypass);
  return {
    code: 'X_BROWSER_TRANSPORT_BYPASS',
    at: `${bypass.file}:${bypass.line}`,
    cause: `${site} calls ${bypass.spelled} in browser-reachable code; ${holder === undefined ? 'no module may' : `only ${holder} may`}, so this request skips the page's record store, idempotency header and principal fence`,
    fix: `edit ${commentSafe(bypass.file)}:${bypass.line} — replace ${bypass.spelled} with ${REPLACEMENT.get(bypass.shape) ?? ''}; then ${context.rerun}`,
    docs: ERROR_DOCS_URL,
  };
}

/**
 * The global handed to another module: the request happens THERE, through a property no rule reads,
 * so the edit is here — stop handing it on (a typed client already sends through the seam) — and
 * the module that took it is the one to move onto the replacement.
 */
function passedFinding(bypass: Bypass, context: FindingContext): Finding {
  const holder = context.holder(bypass.shape);
  const site = siteOf(bypass);
  return {
    code: 'X_BROWSER_TRANSPORT_BYPASS',
    at: `${bypass.file}:${bypass.line}`,
    cause: `${site} passes the global ${bypass.spelled} as a value in browser-reachable code; whatever receives it calls it directly, and ${holder === undefined ? 'no module may' : `only ${holder} may`}, so those requests skip the page's record store, idempotency header and principal fence`,
    fix: `edit ${commentSafe(bypass.file)}:${bypass.line} — delete ${bypass.spelled} (rpc() and queryClient() send through clientTransport when given none), and make the module that took it use ${REPLACEMENT.get(bypass.shape) ?? ''}; then ${context.rerun}`,
    docs: ERROR_DOCS_URL,
  };
}

/**
 * Where the barrel is cut (`ServerBarrel.swaps`). A site that needs the server half is server code,
 * so the mistake is the browser entry's first hop: that edge is the one to delete. `meta` carries
 * the chain for a `--json` reader and for `x fix boundary`, which lists the cut for any file on it.
 */
export function barrelFinding(site: ServerBarrel, _context: FindingContext): Finding {
  const entry = site.chain[0] ?? site.file;
  const at = siteOf(site);
  const meta = {
    entry,
    chain: [...site.chain],
    sites: [`${site.file}:${site.line}`],
    barrel: site.barrel,
    browserEntry: site.entry,
    names: site.names === '*' ? '*' : [...site.names],
    cut: site.swaps ? 'swap' : 'entry',
    ...(site.hop === undefined ? {} : { hop: { spec: site.hop.spec, line: site.hop.line } }),
  };
  const through = site.chain.length > 1 ? ` (${site.chain.map(commentSafe).join(' → ')})` : '';
  if (site.swaps) {
    return {
      code: 'X_BROWSER_SERVER_BARREL',
      at: `${site.file}:${site.line}`,
      cause: `${at} imports ${site.barrel} in browser-reachable code${through}; that barrel is the package's server half, and ${site.entry} is the entry it publishes for a browser`,
      fix: `edit ${commentSafe(site.file)}:${site.line} — change the import from '${site.barrel}' to '${site.entry}'`,
      docs: ERROR_DOCS_URL,
      meta,
    };
  }
  const taken = site.names === '*' ? 'the whole module' : site.names.join(', ');
  const cut =
    site.hop === undefined
      ? { line: site.line, spec: site.barrel }
      : { line: site.hop.line, spec: site.hop.spec };
  const where = siteOf({ file: entry, line: cut.line });
  return {
    code: 'X_BROWSER_SERVER_BARREL',
    at: `${entry}:${cut.line}`,
    cause: `${where} pulls server code into a browser bundle: ${at} takes ${taken} from ${site.barrel}, its server half, not ${site.entry}${through}`,
    fix: `edit ${commentSafe(entry)}:${cut.line} — delete the import of '${cut.spec}' and every use of what it binds; in a browser, read rows through a query (useQuery(<QUERY_REF>, input) from '@ultimat3/realtime') and write through an action (await browserClient.<action>(input))`,
    docs: ERROR_DOCS_URL,
    meta,
  };
}
