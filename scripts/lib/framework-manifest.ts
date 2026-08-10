// The committed framework manifest's shape, its exact bytes on disk, and how two of them differ.
// Split from the generator so the file contract stays pure — no glob, no repo root, nothing a test
// has to build a fake tree for. Mirrors @ultimat3/manifest's emit.ts, which does this same job for
// an app's x.manifest.json.

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
  readonly errorCodes: readonly FrameworkErrorCode[];
}

/**
 * One declared `X_*` code. `owner` is a package's directory name, or `scripts` for a code only
 * this repo's own gate throws — the field is not called `package` because that was true only
 * while the scanner read one filename per package, and a code declared in `scripts/boundaries.ts`
 * has an owner but no package. `at` is where the declaration is, so the answer to "where does
 * this come from?" is in the file rather than one grep away.
 */
export interface FrameworkErrorCode {
  readonly code: string;
  readonly owner: string;
  readonly at: string;
}

/** What `buildId` is computed over: the whole manifest except `buildId` itself. */
export type FrameworkManifestBody = Omit<FrameworkManifest, 'buildId'>;

/** Top-level key order in the file. Fixed, so reordering a struct literal is not a diff. */
export const KEY_ORDER: readonly (keyof FrameworkManifest)[] = [
  'version',
  'buildId',
  'tiers',
  'packages',
  'errorCodes',
];

/** The exact bytes on disk: two-space indent and a trailing newline, because git diffs this file. */
export function frameworkManifestJson(manifest: FrameworkManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) ordered[key] = manifest[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Content hash of the whole body — tiers and package versions included, so any fact that moves
 * moves the hash. Excludes `buildId` itself and runs over the canonical form, so a reader can
 * recompute it from the file alone and catch a hand edit.
 */
export function contentHash(body: FrameworkManifestBody): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(canonical(body));
  return hasher.digest('hex').slice(0, 12);
}

/** Sorted-key JSON. Never `JSON.stringify(value)` directly — key order is not a contract. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
  return out;
}

/** Read and structurally check the committed file. `undefined` when absent or unparseable. */
export async function readFrameworkManifest(path: string): Promise<FrameworkManifest | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return undefined;
  }
  return isFrameworkManifest(parsed) ? parsed : undefined;
}

function isFrameworkManifest(value: unknown): value is FrameworkManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.buildId === 'string' &&
    typeof record.tiers === 'object' &&
    record.tiers !== null &&
    Array.isArray(record.packages) &&
    Array.isArray(record.errorCodes)
  );
}

/**
 * Which top-level sections of the committed manifest no longer describe the code; `[]` is fresh.
 * Sections rather than a byte diff: enough to point at what moved without dumping the file.
 */
export function manifestDrift(
  onDisk: FrameworkManifest | undefined,
  fresh: FrameworkManifest,
): readonly string[] {
  if (onDisk === undefined) return ['file is missing or unreadable'];
  const differences = KEY_ORDER.filter(
    (key) => key !== 'buildId' && canonical(onDisk[key]) !== canonical(fresh[key]),
  ).map((key) => `${key} differs`);
  // A body that matches under a `buildId` that does not means the file was hand-edited: still drift.
  if (differences.length === 0 && onDisk.buildId !== fresh.buildId) return ['buildId differs'];
  return differences;
}
