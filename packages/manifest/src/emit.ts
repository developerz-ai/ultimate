// Serialisation and I/O for `x.manifest.json`, plus the drift check `x verify` runs.
//
// The serialiser writes keys in a FIXED order rather than whatever `JSON.stringify` produces,
// so a refactor that reorders a struct literal does not produce a diff. Two-space indent and
// a trailing newline: the file is reviewed by humans and diffed by git.

import { canonicalJson } from '@ultimat3/core';
import { contentHash } from './build';
import { ManifestDriftError } from './errors';
import type { Manifest } from './schema';
import { isManifest } from './schema';

export const MANIFEST_FILENAME = 'x.manifest.json';

/**
 * Top-level key order. Explicit so the file reads in a sensible order every time.
 *
 * `as const satisfies` and a test that WALKS it, the treatment `ARRAY_SECTIONS` already has
 * (`schema.ts`) — the annotation catches a key that is not on `Manifest`, only a walk catches one
 * that is missing. It was a bare annotation, and `manifestJson` writes these keys and no others
 * while `contentHash` hashes the whole body: a 14th field added to `Manifest` would have gone into
 * the hash and been dropped from the file, after which `assertNoDrift` convicts the committed
 * manifest as HAND_EDITED — a correct refusal carrying the wrong diagnosis, about a file nobody
 * touched. Exported for that test alone; deliberately NOT re-exported by `src/index.ts`, because
 * the ORDER is this module's business and a public one would be semver-locked.
 */
export const KEY_ORDER = [
  'manifestVersion',
  'buildId',
  'app',
  'routes',
  'entities',
  'actions',
  'queries',
  'jobs',
  'tasks',
  'policies',
  'permissions',
  'locales',
  'errorCodes',
] as const satisfies readonly (keyof Manifest)[];

/** The exact bytes written to disk. Deterministic for a given manifest. */
export function manifestJson(manifest: Manifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) ordered[key] = manifest[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface EmitInput {
  readonly manifest: Manifest;
  /** Defaults to `./x.manifest.json`. */
  readonly path?: string;
  /** `--json`: print to stdout instead of writing. Machine-readable output on everything. */
  readonly stdout?: boolean;
}

export interface EmitResult {
  readonly path: string;
  readonly bytes: number;
  readonly buildId: string;
  /** False when the file already contained these exact bytes. */
  readonly changed: boolean;
}

export async function emitManifest(input: EmitInput): Promise<EmitResult> {
  const path = input.path ?? `./${MANIFEST_FILENAME}`;
  const text = manifestJson(input.manifest);
  // The bytes on disk, never `text.length`: a manifest carries the APP's strings — a locale name,
  // an entity description, a title in the app's own language — and `String.length` counts UTF-16
  // code units, so it under-reports every one of them and over-reports nothing. `agents-md.ts`
  // measures the same quantity the same way.
  const bytes = Buffer.byteLength(text, 'utf8');

  if (input.stdout === true) {
    // stdout is the wire in `--json` mode; nothing else may be written to it — and the write is
    // AWAITED, because a write to a pipe is asynchronous and `process.exit()` throws away whatever
    // is still queued. Unawaited, the largest payload the CLI prints was the one that lost bytes,
    // exactly as `scripts/stdout-truncation.test.ts` documents for the same bug elsewhere.
    await Bun.write(Bun.stdout, text);
    return { path, bytes, buildId: input.manifest.buildId, changed: false };
  }

  const existing = await readIfExists(path);
  // Skip the write when nothing moved: an unchanged mtime keeps file watchers quiet.
  if (existing === text) {
    return { path, bytes, buildId: input.manifest.buildId, changed: false };
  }
  await Bun.write(path, text);
  return { path, bytes, buildId: input.manifest.buildId, changed: true };
}

/** Read and structurally validate a manifest. `undefined` when absent or unparseable. */
export async function readManifest(path?: string): Promise<Manifest | undefined> {
  const text = await readIfExists(path ?? `./${MANIFEST_FILENAME}`);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isManifest(parsed) ? parsed : undefined;
}

/**
 * A file that does not describe itself. Kept apart from `describeDrift`'s section list because
 * it is a different repair story: the code did not move, someone typed into the generated file.
 */
const HAND_EDITED = 'hand-edited — its buildId does not hash its own contents';

/**
 * Fail if the committed file does not match a freshly built manifest. Drift means an agent
 * reading `x.manifest.json` is reading a description of a program that no longer exists —
 * strictly worse than no manifest at all.
 */
export async function assertNoDrift(input: {
  readonly manifest: Manifest;
  readonly path?: string;
}): Promise<void> {
  const path = input.path ?? `./${MANIFEST_FILENAME}`;
  const onDisk = await readManifest(path);
  if (onDisk === undefined) {
    throw new ManifestDriftError({ path, differences: ['file is missing or unreadable'] });
  }
  // Before the ids are compared, not after: a body edited by hand with its `buildId` left alone
  // still carries the id a fresh build produces, so an id-only gate waves through the one
  // manifest that lies about the code. `buildId` hashes the body, so the file convicts itself.
  if (!verifyBuildId(onDisk)) {
    throw new ManifestDriftError({ path, differences: [HAND_EDITED] });
  }
  if (onDisk.buildId === input.manifest.buildId) return;

  throw new ManifestDriftError({ path, differences: describeDrift(onDisk, input.manifest) });
}

/** Which top-level sections moved. Enough to point at the change without dumping the file. */
function describeDrift(onDisk: Manifest, fresh: Manifest): readonly string[] {
  const differences: string[] = [];
  for (const key of KEY_ORDER) {
    if (key === 'buildId') continue;
    if (canonicalJson(onDisk[key]) !== canonicalJson(fresh[key]))
      differences.push(`${key} differs`);
  }
  return differences.length > 0 ? differences : ['buildId differs'];
}

/** Verify a file's `buildId` against its own contents — catches a hand-edited manifest. */
export function verifyBuildId(manifest: Manifest): boolean {
  const { buildId, ...body } = manifest;
  return contentHash(body) === buildId;
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return file.text();
}
