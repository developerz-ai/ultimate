#!/usr/bin/env bun
// Enforce, as a build error, that browser code has ONE HTTP function and ONE socket. Plan 101 put
// every page request through `@ultimat3/core`'s `clientTransport` — credentials, the idempotency
// header, the record envelope, the principal fence — and a raw `fetch(` in an island skips all four:
// its rows never reach the page's store and it keeps running for the previous principal after a
// sign-out. The same holds for a socket the page opens itself beside the framework's one.
//
// BROWSER-REACHABLE is derived, never listed: every `*.island.tsx` in a tracked app or a package,
// every framework module that calls the client seam itself (`clientTransport` / `pageClient` —
// browser code by its own statement, whether or not an island imports it yet), and the import
// closure of each, followed NAME BY NAME through barrels (`lib/import-closure.ts`).
// A server-only module — `auth/oauth-*`, `mail/driver-resend.ts`, `jobs/webhook.ts` — is out of
// scope because no island reaches it, not because a pin says so.
//
// It also refuses a SERVER BARREL in that closure: `@ultimat3/entity` where the package publishes
// `@ultimat3/entity/record` for a browser (`lib/server-barrels.ts`, derived from `exports`).
//
// WHAT IT CANNOT SEE: a browser module that neither is an island, nor names the seam, nor is
// imported by either; a fetch reached through a computed member (`globalThis['fetch']`); and a
// bare `fetch(` in a file that also binds a local `fetch` (see `bindsFetch`). A floor, not a proof.
//
//   bun run scripts/browser-transport.ts [--json]

import { isJsonObject, maskLiterals } from '@ultimat3/core';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import { type ClosureHost, importClosure } from './lib/import-closure';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { type BarrelImport, barrelImports, serverBarrels } from './lib/server-barrels';
import { isTestPath } from './lib/source-scan';
import { type TransportCall, type TransportShape, transportCalls } from './lib/transport-calls';

const SCRIPT = 'browser-transport';

/** The one module each shape may appear in. `eventsource` has no row: nothing ships one. */
export const TRANSPORT_SEAMS: ReadonlyMap<TransportShape, string> = new Map([
  ['fetch', 'packages/core/src/client-dispatch.ts'],
  ['websocket', 'packages/realtime/src/browser-socket.ts'],
  ['xhr', 'packages/storage/src/upload-client.ts'],
]);

/** The service worker's realm: no page, no store, no principal fence to bypass. */
export const SERVICE_WORKER_FILES: ReadonlySet<string> = new Set([
  'packages/pwa/src/service-worker.ts',
  'packages/pwa/src/strategies.ts',
]);

export interface Bypass extends TransportCall {
  readonly file: string;
}

export interface ServerBarrel extends BarrelImport {
  readonly file: string;
}

export interface TransportTree {
  /** Repo-relative POSIX path → source, for every file a closure may read. */
  readonly files: ReadonlyMap<string, string>;
  /** Bare specifier → file: `@ultimat3/core` → `packages/core/src/index.ts`, app aliases too. */
  readonly aliases: ReadonlyMap<string, string>;
  /** `@postly/web/*` style prefixes: specifier prefix → path prefix. */
  readonly prefixes: ReadonlyMap<string, string>;
}

export const isIsland = (path: string): boolean => path.endsWith('.island.tsx');

/** A framework module naming the page's client seam is browser code by its own statement. */
const NAMES_SEAM = /\b(?:clientTransport|pageClient)\s*[(<]/;

/** Where the closure starts: islands, plus framework modules that call the seam themselves. */
export function browserEntries(files: ReadonlyMap<string, string>): readonly string[] {
  return [...files.entries()]
    .filter(([path, source]) => {
      if (isTestPath(path)) return false;
      if (isIsland(path)) return true;
      // Masked: a scaffold template that EMITS `clientTransport(` into an app is not browser code.
      return path.startsWith('packages/') && NAMES_SEAM.test(maskLiterals(source));
    })
    .map(([path]) => path)
    .sort();
}

function hostFor(tree: TransportTree): ClosureHost {
  return {
    read: (path) => tree.files.get(path),
    alias: (spec) => {
      const exact = tree.aliases.get(spec);
      if (exact !== undefined) return exact;
      for (const [prefix, target] of tree.prefixes) {
        if (!spec.startsWith(prefix)) continue;
        const rest = `${target}${spec.slice(prefix.length)}`;
        for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
          if (tree.files.has(`${rest}${suffix}`)) return `${rest}${suffix}`;
        }
      }
      return undefined;
    },
  };
}

/** The whole rule over a tree, pure. */
export function checkBrowserTransport(tree: TransportTree): {
  readonly entries: readonly string[];
  readonly reachable: readonly string[];
  readonly bypasses: readonly Bypass[];
  readonly barrels: readonly ServerBarrel[];
} {
  const entries = browserEntries(tree.files);
  const reachable = importClosure(hostFor(tree), entries);
  const bypasses: Bypass[] = [];
  const barrels: ServerBarrel[] = [];
  const serverOnly = serverBarrels(tree.aliases.keys());
  for (const file of reachable) {
    if (isTestPath(file) || SERVICE_WORKER_FILES.has(file)) continue;
    const source = tree.files.get(file) ?? '';
    for (const call of transportCalls(source)) {
      if (TRANSPORT_SEAMS.get(call.shape) === file) continue;
      bypasses.push({ ...call, file });
    }
    // A package's own modules may import its own barrel's neighbours; only a FOREIGN import of
    // the barrel is the island paying for the server half.
    for (const found of barrelImports(source, serverOnly)) {
      if (tree.aliases.get(found.barrel)?.split('/src/')[0] === file.split('/src/')[0]) continue;
      barrels.push({ ...found, file });
    }
  }
  return { entries, reachable, bypasses, barrels };
}

const REPLACEMENT: ReadonlyMap<TransportShape, string> = new Map([
  [
    'fetch',
    "use useQuery() / useMutation() / <action>.client() / useChannel(), or clientTransport from '@ultimat3/core'",
  ],
  ['websocket', "use useQuery() / useChannel() — the page's one socket is @ultimat3/realtime's"],
  [
    'xhr',
    "use clientTransport from '@ultimat3/core'; upload progress is uploadFile() from '@ultimat3/storage'",
  ],
  ['eventsource', 'use useQuery() / useChannel() — realtime frames arrive on the page socket'],
]);

export function bypassFinding(bypass: Bypass): Finding {
  const seam = TRANSPORT_SEAMS.get(bypass.shape);
  return {
    code: 'X_BROWSER_TRANSPORT_BYPASS',
    at: `${bypass.file}:${bypass.line}`,
    cause: `${bypass.file}:${bypass.line} calls ${bypass.spelled} in browser-reachable code; ${seam === undefined ? 'no module may' : `only ${seam} may`}, so this request skips the page's record store, idempotency header and principal fence`,
    fix: `edit ${bypass.file}:${bypass.line} — ${REPLACEMENT.get(bypass.shape) ?? ''}; re-read the tree with: bun run browser-transport --json`,
  };
}

export function barrelFinding(site: ServerBarrel): Finding {
  return {
    code: 'X_BROWSER_SERVER_BARREL',
    at: `${site.file}:${site.line}`,
    cause: `${site.file}:${site.line} imports ${site.barrel} in browser-reachable code; that barrel is the package's server half, and ${site.entry} is the entry it publishes for a browser`,
    fix: `edit ${site.file}:${site.line} — import from '${site.entry}' instead of '${site.barrel}'; re-read the tree with: bun run browser-transport --json`,
  };
}

/** The seam must still HOLD the call it is exempt for, or a moved seam reads as a clean tree. */
export function seamFindings(tree: TransportTree): readonly Finding[] {
  const seam = TRANSPORT_SEAMS.get('fetch') ?? '';
  const source = tree.files.get(seam);
  const holds = source !== undefined && transportCalls(source).some((c) => c.shape === 'fetch');
  if (holds) return [];
  return [
    {
      code: 'X_BROWSER_TRANSPORT_UNSCANNED',
      at: 'scripts/browser-transport.ts',
      cause: `${seam} does not call fetch, so the exemption names a module that is no longer the seam and every bypass test is vacuous`,
      fix: 'edit TRANSPORT_SEAMS in scripts/browser-transport.ts to name the module that calls globalThis.fetch, then: bun run browser-transport --json',
    },
  ];
}

export function transportResult(tree: TransportTree): ScriptResult {
  const { entries, reachable, bypasses, barrels } = checkBrowserTransport(tree);
  const findings = [
    ...seamFindings(tree),
    ...bypasses.map(bypassFinding),
    ...barrels.map(barrelFinding),
  ];
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${entries.length} island(s), ${reachable.length} browser-reachable module(s), one transport`
        : `${findings.length} browser transport finding(s) across ${reachable.length} browser-reachable module(s)`,
    findings,
    data: { entries, reachable: reachable.length, bypasses, barrels },
  };
}

const GLOBS = ['packages/*/src/**/*.{ts,tsx}', `${APP_ROOTS}/*/**/*.{ts,tsx}`];
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

/** `@ultimat3/<pkg>` and its subpaths, from each manifest's `exports` — never a hand list. */
async function packageAliases(root: string, aliases: Map<string, string>): Promise<void> {
  for await (const manifest of new Bun.Glob('packages/*/package.json').scan({ cwd: root })) {
    const parsed: unknown = await Bun.file(`${root}/${manifest}`).json();
    if (!isJsonObject(parsed) || typeof parsed['name'] !== 'string') continue;
    const dir = manifest.split('/').slice(0, 2).join('/');
    const exports = isJsonObject(parsed['exports']) ? parsed['exports'] : {};
    for (const [sub, target] of Object.entries(exports)) {
      if (typeof target !== 'string' || sub.includes('*')) continue;
      const spec = sub === '.' ? parsed['name'] : `${parsed['name']}${sub.slice(1)}`;
      aliases.set(spec, `${dir}/${target.replace(/^\.\//, '')}`);
    }
  }
}

/** A tracked app's own `compilerOptions.paths`, exact keys and `/*` prefixes alike. */
async function appAliases(
  root: string,
  aliases: Map<string, string>,
  prefixes: Map<string, string>,
): Promise<void> {
  for await (const config of new Bun.Glob(`${APP_ROOTS}/*/tsconfig.json`).scan({ cwd: root })) {
    const parsed: unknown = await Bun.file(`${root}/${config}`).json();
    const options = isJsonObject(parsed) ? parsed['compilerOptions'] : undefined;
    const paths = isJsonObject(options) ? options['paths'] : undefined;
    if (!isJsonObject(paths)) continue;
    const app = config.split('/').slice(0, 2).join('/');
    for (const [key, targets] of Object.entries(paths)) {
      const first = Array.isArray(targets) ? targets[0] : undefined;
      if (typeof first !== 'string') continue;
      const target = `${app}/${first.replace(/^\.\//, '')}`;
      if (key.endsWith('/*')) prefixes.set(key.slice(0, -1), target.replace(/\*$/, ''));
      else aliases.set(key, target);
    }
  }
}

export async function readTransportTree(root: string): Promise<TransportTree> {
  const files = new Map<string, string>();
  for (const glob of GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      const posix = path.split('\\').join('/');
      if (NOT_SOURCE.test(posix)) continue;
      files.set(posix, await Bun.file(`${root}/${posix}`).text());
    }
  }
  const aliases = new Map<string, string>();
  const prefixes = new Map<string, string>();
  await packageAliases(root, aliases);
  await appAliases(root, aliases, prefixes);
  return { files, aliases, prefixes };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(transportResult(await readTransportTree(repoRoot())), args.json);
}
