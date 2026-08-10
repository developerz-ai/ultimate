#!/usr/bin/env bun
// Generated facts about the framework itself: packages, tiers, every X_* error code and where it is
// declared. Same rule as an app's x.manifest.json — emitted from the code, committed, never
// hand-edited — so "which codes exist?" is a file read instead of a grep, and the gate can fail on
// a copy the code has moved past.
//
//   bun run scripts/manifest.ts [--out framework.manifest.json] [--json]

import { resolve } from 'node:path';
import { collectDeclaredCodes } from '@ultimat3/cli';
import { flagString, parseScriptArgs } from './lib/args';
import type {
  FrameworkErrorCode,
  FrameworkManifest,
  FrameworkManifestBody,
} from './lib/framework-manifest';
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

/**
 * Who a declaration belongs to, read off its path: a package by its directory name, anything else
 * by its top directory — `scripts` for the gate's own codes, which ship to nobody and so can
 * never be a package's.
 */
export function ownerOf(path: string): string {
  const segments = path.split('/');
  return (segments[0] === 'packages' ? segments[1] : segments[0]) ?? '';
}

/**
 * Every declared code, from the same walk and the same scanner the `errors` gate step uses — not a
 * second regex over one filename per package. That is what the old scan was: one `src/errors.ts`
 * per package and nothing else, so a code thrown from `scripts/boundaries.ts`,
 * `packages/core/src/roles.ts` or any other non-registry module was missing from a file whose
 * whole claim is "every X_* code".
 */
export async function collectErrorCodes(root: string): Promise<readonly FrameworkErrorCode[]> {
  const sites = await collectDeclaredCodes(root);
  return sites.map((site) => ({ code: site.code, owner: ownerOf(site.at), at: site.at }));
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
