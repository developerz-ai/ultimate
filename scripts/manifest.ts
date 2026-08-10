#!/usr/bin/env bun
// Generated facts about the framework itself: packages, tiers, every X_* error code and where it is
// declared. Same rule as an app's x.manifest.json — emitted from the code, committed, never
// hand-edited — so "which codes exist?" is a file read instead of a grep, and the gate can fail on
// a copy the code has moved past.
//
//   bun run scripts/manifest.ts [--out framework.manifest.json] [--json]

import { join, resolve } from 'node:path';
import { flagString, parseScriptArgs } from './lib/args';
import type { FrameworkManifest, FrameworkManifestBody } from './lib/framework-manifest';
import {
  contentHash,
  frameworkManifestJson,
  manifestDrift,
  readFrameworkManifest,
} from './lib/framework-manifest';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { TIERS } from './lib/tiers';
import { listWorkspaces } from './lib/workspaces';

/**
 * Committed at the repo root, beside llms.txt. Deliberately not `x.manifest.json`: that filename
 * is an *app's* manifest, a different schema, and `x verify` would read this one as that.
 */
export const DEFAULT_OUT = 'framework.manifest.json';

const CODE_PATTERN = /'(X_[A-Z0-9_]+)'/g;

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
  const body: FrameworkManifestBody = {
    version: 1,
    tiers: Object.fromEntries(Object.entries(TIERS).map(([tier, names]) => [tier, [...names]])),
    packages: workspaces.map((workspace) => ({
      name: workspace.name,
      version: workspace.version,
      tier: workspace.tier,
      private: workspace.private,
    })),
    errorCodes,
  };
  return { ...body, buildId: contentHash(body) };
}

/**
 * The gate's question: does the committed file still describe this tree? Builds fresh, reads the
 * committed copy and names the sections that moved. An absolute `out` wins over `root`, so a test
 * can point this at a temp file instead of the repo.
 */
export async function frameworkManifestDrift(
  root: string,
  out: string = DEFAULT_OUT,
): Promise<readonly string[]> {
  const [fresh, onDisk] = await Promise.all([
    buildManifest(root),
    readFrameworkManifest(resolve(root, out)),
  ]);
  return manifestDrift(onDisk, fresh);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const out = flagString(args, 'out') ?? DEFAULT_OUT;
  const manifest = await buildManifest(root);
  await Bun.write(resolve(root, out), frameworkManifestJson(manifest));
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
