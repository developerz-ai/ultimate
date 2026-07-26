#!/usr/bin/env bun
// Generated facts about the framework itself: packages, tiers, every X_* error code and where it
// is declared. Same rule as an app's x.manifest.json — emitted from the code, never hand-edited,
// so "which codes exist?" is a file read instead of a grep.
//
//   bun run scripts/manifest.ts [--out .x/manifest.json] [--json]

import { join } from 'node:path';
import { flagString, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { TIERS } from './lib/tiers';
import { listWorkspaces } from './lib/workspaces';

export const DEFAULT_OUT = join('.x', 'manifest.json');

const CODE_PATTERN = /'(X_[A-Z0-9_]+)'/g;

export interface FrameworkManifest {
  readonly version: 1;
  readonly buildId: string;
  readonly tiers: Readonly<Record<string, readonly string[]>>;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly tier: number;
    readonly private: boolean;
  }[];
  readonly errorCodes: readonly { readonly code: string; readonly package: string }[];
}

/** Codes are string literals in `src/errors.ts`; reading them is exact and needs no runtime. */
export async function collectErrorCodes(
  root: string,
): Promise<readonly { code: string; package: string }[]> {
  const found = new Map<string, string>();
  for await (const path of new Bun.Glob('packages/*/src/errors.ts').scan({
    cwd: root,
    absolute: false,
  })) {
    const owner = path.split('/')[1] ?? '';
    const source = await Bun.file(join(root, path)).text();
    for (const match of source.matchAll(CODE_PATTERN)) {
      const code = match[1];
      if (code !== undefined && !found.has(code)) found.set(code, owner);
    }
  }
  return [...found.entries()]
    .map(([code, owner]) => ({ code, package: owner }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function buildManifest(root: string): Promise<FrameworkManifest> {
  const workspaces = await listWorkspaces(root);
  const errorCodes = await collectErrorCodes(root);
  const hasher = new Bun.CryptoHasher('sha256');
  for (const workspace of workspaces) hasher.update(`${workspace.name}@${workspace.version}`);
  for (const entry of errorCodes) hasher.update(entry.code);
  return {
    version: 1,
    buildId: hasher.digest('hex').slice(0, 12),
    tiers: Object.fromEntries(Object.entries(TIERS).map(([tier, names]) => [tier, [...names]])),
    packages: workspaces.map((workspace) => ({
      name: workspace.name,
      version: workspace.version,
      tier: workspace.tier,
      private: workspace.private,
    })),
    errorCodes,
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const out = flagString(args, 'out') ?? DEFAULT_OUT;
  const manifest = await buildManifest(root);
  await Bun.write(join(root, out), `${JSON.stringify(manifest, null, 2)}\n`);
  report(
    {
      ok: true,
      script: 'manifest',
      summary: `${manifest.packages.length} packages, ${manifest.errorCodes.length} error codes -> ${out}`,
      data: manifest,
    },
    args.json,
  );
}
