// Do the committed generated files still describe the code? ONE check, asked by `x manifest
// --check` and by the gate's `manifest` step through this function — two commands answering
// differently about one file is itself the drift these files exist to prevent.

// why: Bun has no synchronous existence probe, and `hasCommittedContract` guards an app load.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; Bun.file takes a path already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Manifest } from '@ultimat3/manifest';
import { assertNoDrift, MANIFEST_FILENAME } from '@ultimat3/manifest';
import { OPENAPI_FILE, openApiStaleness } from './app-openapi';
import { APP_CONFIG_FILE } from './app-root';
import type { Finding } from './output';
import { findingFrom } from './output';

/** Whether there is any committed contract here to judge — the cheap question, asked first. */
export const hasCommittedContract = (root: string): boolean =>
  existsSync(join(root, MANIFEST_FILENAME)) || existsSync(join(root, OPENAPI_FILE));

/**
 * `x.manifest.json` was never written. An app root only: the framework monorepo emits
 * `framework.manifest.json` and has no `x.manifest.json` to be missing. `AGENTS.md` tells an agent
 * that facts live in this file, and after `x new` and every generator nothing had run the one
 * command that writes it while the gate reported green (#F7).
 */
export function manifestMissingFindings(root: string): readonly Finding[] {
  if (!existsSync(join(root, APP_CONFIG_FILE))) return [];
  if (existsSync(join(root, MANIFEST_FILENAME))) return [];
  return [
    {
      code: 'X_MANIFEST_MISSING',
      cause: `${MANIFEST_FILENAME} does not exist, so every fact an agent reads about this app — route table, action schemas, policies, error codes — is unavailable`,
      fix: 'x manifest',
      docs: ERROR_DOCS_URL,
      at: MANIFEST_FILENAME,
    },
  ];
}

/**
 * Every way the committed files disagree with `manifest`, the app as the code declares it now:
 * `x.manifest.json` missing (`X_MANIFEST_MISSING`) or drifted (`X_MANIFEST_DRIFT` — a body that no
 * longer hashes to its own `buildId` included), and `openapi.json` or a bearer mount's document
 * stale (`X_MANIFEST_STALE`). The spec is judged whether or not the manifest is there: it is a
 * published contract on its own, and the typed client is generated from it.
 */
export async function manifestStaleness(
  root: string,
  manifest: Manifest,
): Promise<readonly Finding[]> {
  const path = join(root, MANIFEST_FILENAME);
  const findings: Finding[] = [...manifestMissingFindings(root)];
  if (existsSync(path)) {
    try {
      await assertNoDrift({ manifest, path });
    } catch (error) {
      findings.push({ ...findingFrom(error), at: MANIFEST_FILENAME });
    }
  }
  return [...findings, ...(await openApiStaleness(root, manifest))];
}
