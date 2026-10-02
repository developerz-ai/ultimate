#!/usr/bin/env bun
// This repository's run of the browser-transport rule: ONE HTTP function and ONE socket in browser
// code. The rule itself is `@ultimat3/cli`'s (`packages/cli/src/browser-transport.ts`) — the same
// function every app's `x verify` runs on its `boundaries` step — so this file only says what is
// different HERE: the tree is the framework's own packages plus the tracked apps, and the three
// seams are files in it rather than functions behind `node_modules`.
//
// Browser-reachable, the server-barrel half and what the rule cannot see are stated once, in that
// module's header.
//
//   bun run scripts/browser-transport.ts [--json]

import { isJsonObject } from '@ultimat3/core';
import type { Bypass, FindingContext, ServerBarrel } from '../packages/cli/src/browser-transport';
import {
  browserEntries,
  checkBrowserTransport as checkTransport,
  barrelFinding as cliBarrelFinding,
  bypassFinding as cliBypassFinding,
} from '../packages/cli/src/browser-transport';
import type { ClosureHost } from '../packages/cli/src/import-closure';
import { serverBarrels } from '../packages/cli/src/server-barrels';
import type { TransportShape } from '../packages/cli/src/transport-calls';
import { transportCalls } from '../packages/cli/src/transport-calls';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

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

export interface TransportTree {
  /** Repo-relative POSIX path → source, for every file a closure may read. */
  readonly files: ReadonlyMap<string, string>;
  /** Bare specifier → file: `@ultimat3/core` → `packages/core/src/index.ts`, app aliases too. */
  readonly aliases: ReadonlyMap<string, string>;
  /** `@postly/web/*` style prefixes: specifier prefix → path prefix. */
  readonly prefixes: ReadonlyMap<string, string>;
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

/** The rule over this repository's tree: the CLI's function, handed the repo's seams. */
export function checkBrowserTransport(tree: TransportTree): {
  readonly entries: readonly string[];
  readonly reachable: readonly string[];
  readonly bypasses: readonly Bypass[];
  readonly barrels: readonly ServerBarrel[];
} {
  // A FRAMEWORK module naming the client seam is browser code by its own statement; an app's is
  // reached through its islands, exactly as the app's own gate reaches it.
  const entries = browserEntries(tree.files, (path) => path.startsWith('packages/'));
  const checked = checkTransport({
    entries,
    host: hostFor(tree),
    seams: TRANSPORT_SEAMS,
    exempt: SERVICE_WORKER_FILES,
    barrels: serverBarrels(tree.aliases.keys()),
    // A package's own modules may import its own barrel's neighbours.
    ownsBarrel: (file, barrel) =>
      tree.aliases.get(barrel)?.split('/src/')[0] === file.split('/src/')[0],
  });
  return { entries, ...checked };
}

const CONTEXT: FindingContext = {
  holder: (shape) => TRANSPORT_SEAMS.get(shape),
  rerun: 'bun run browser-transport --json',
};

export const bypassFinding = (bypass: Bypass): Finding => cliBypassFinding(bypass, CONTEXT);

export const barrelFinding = (site: ServerBarrel): Finding => cliBarrelFinding(site, CONTEXT);

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
