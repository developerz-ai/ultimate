// OpenAPI is a projection of the manifest, never a hand-maintained file (axiom 2). The diff is
// what `x verify` gates on: removing an operation, or adding a required input to one, breaks
// every client that already shipped — so it fails unless the package version moved.

import type { AppManifest, ManifestEntry } from './manifest-scan';
import type { Finding } from './output';

export interface OpenApiOperation {
  readonly operationId: string;
  readonly method: 'post' | 'get';
  readonly required: readonly string[];
  readonly summary: string;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: { readonly title: string; readonly version: string };
  readonly operations: readonly OpenApiOperation[];
}

const requiredOf = (entry: ManifestEntry): readonly string[] => {
  const input = entry.meta['input'];
  if (typeof input !== 'object' || input === null) return [];
  const required = (input as Record<string, unknown>)['required'];
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
};

const summaryOf = (entry: ManifestEntry): string => {
  const mcp = entry.meta['mcp'];
  if (typeof mcp === 'object' && mcp !== null) {
    const description = (mcp as Record<string, unknown>)['description'];
    if (typeof description === 'string') return description;
  }
  return entry.name;
};

/** Actions and mutators are POST operations; queries are GET. Nothing else has an HTTP surface. */
export function buildOpenApi(manifest: AppManifest, version: string): OpenApiDocument {
  const operations = manifest.entries
    .filter(
      (entry) => entry.kind === 'action' || entry.kind === 'mutator' || entry.kind === 'query',
    )
    .map<OpenApiOperation>((entry) => ({
      operationId: entry.name,
      method: entry.kind === 'query' ? 'get' : 'post',
      required: requiredOf(entry),
      summary: summaryOf(entry),
    }));
  return {
    openapi: '3.1.0',
    info: { title: 'app', version },
    operations,
  };
}

export interface DiffOptions {
  /** True when the published version moved in this change — breaking diffs are then allowed. */
  readonly versionBumped: boolean;
}

/**
 * Breaking changes, in the only two shapes that matter for a typed client: an operation that
 * disappeared, and an operation that started requiring an input it did not require before.
 */
export function diffOpenApi(
  committed: OpenApiDocument,
  current: OpenApiDocument,
  options: DiffOptions,
): readonly Finding[] {
  if (options.versionBumped) return [];
  const findings: Finding[] = [];
  const byId = new Map(current.operations.map((operation) => [operation.operationId, operation]));
  for (const before of committed.operations) {
    const after = byId.get(before.operationId);
    if (after === undefined) {
      findings.push({
        code: 'X_CONTRACT_BREAKING',
        cause: `operation "${before.operationId}" was removed from the published contract`,
        fix: `restore it, or bump the package version in package.json`,
        docs: 'https://ultimate.dev/errors/X_CONTRACT_BREAKING',
        at: 'openapi.json',
      });
      continue;
    }
    const added = after.required.filter((key) => !before.required.includes(key));
    if (added.length > 0) {
      findings.push({
        code: 'X_CONTRACT_BREAKING',
        cause: `operation "${before.operationId}" now requires ${added.join(', ')}`,
        fix: `give the new input a .default(), or bump the package version in package.json`,
        docs: 'https://ultimate.dev/errors/X_CONTRACT_BREAKING',
        at: 'openapi.json',
      });
    }
  }
  return findings;
}
