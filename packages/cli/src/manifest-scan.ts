// Generated facts, not hand-written prose. This scans an app's surfaces, imports each module and
// records every primitive descriptor it exports — the single source of x.manifest.json, the route
// table, the OpenAPI document and the MCP tool list. Never parses source text: a primitive is
// whatever the framework's own factories produced, so the manifest cannot drift from the code.

import { relative, sep } from 'node:path';

export const PRIMITIVE_KINDS = [
  'entity',
  'policy',
  'action',
  'mutator',
  'query',
  'job',
  'route',
  'task',
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

const KINDS = new Set<string>(PRIMITIVE_KINDS);

export interface ManifestEntry {
  readonly kind: PrimitiveKind;
  readonly name: string;
  readonly file: string;
  /** Surface the module lives in: site | app | api | shared | admin | package. */
  readonly surface: string;
  /** Route path, present for `kind: 'route'`. */
  readonly path?: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface AppManifest {
  readonly version: 1;
  readonly buildId: string;
  readonly entries: readonly ManifestEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A primitive descriptor is any object carrying a `kind` the framework owns. */
export function readKind(value: unknown): PrimitiveKind | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value['kind'];
  if (typeof kind === 'string' && KINDS.has(kind)) return kind as PrimitiveKind;
  return undefined;
}

const META_KEYS = [
  'render',
  'offline',
  'hydrate',
  'budget',
  'live',
  'cron',
  'tz',
  'retry',
  'idempotencyKey',
  'mcp',
  'cache',
  'policy',
  'table',
] as const;

function metaOf(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    const found = value[key];
    if (found !== undefined) out[key] = typeof found === 'function' ? 'fn' : found;
  }
  return out;
}

/**
 * `apps/web/site/pricing/page.tsx` → `/pricing`; `apps/web/app/orgs/[id]/page.tsx` → `/orgs/:id`.
 * Surface directories are stripped: the URL is the path *inside* a surface.
 */
export function routePathFor(fileRelativeToApp: string): string {
  const parts = fileRelativeToApp.split(sep).filter((part) => part.length > 0);
  const surfaceAt = parts.findIndex((part) => part === 'site' || part === 'app');
  const tail = parts.slice(surfaceAt + 1, -1).map((part) => {
    const dynamic = /^\[(?:\.\.\.)?(.+)\]$/.exec(part);
    if (dynamic === null) return part;
    return part.startsWith('[...') ? `*${dynamic[1] ?? ''}` : `:${dynamic[1] ?? ''}`;
  });
  return `/${tail.join('/')}`;
}

export function surfaceFor(fileRelativeToApp: string): string {
  const parts = fileRelativeToApp.split(sep);
  const known = ['site', 'app', 'api', 'shared', 'admin'];
  const found = parts.find((part) => known.includes(part));
  return found ?? 'package';
}

export interface ScanOptions {
  readonly root: string;
  /** Injected for tests; defaults to a real dynamic import. */
  readonly load?: (absolutePath: string) => Promise<Record<string, unknown>>;
  readonly globs?: readonly string[];
}

const DEFAULT_GLOBS = [
  'apps/*/{site,app,api,shared}/**/*.{ts,tsx}',
  'apps/*/*.{ts,tsx}',
  'packages/*/src/**/*.ts',
];

const load = async (absolutePath: string): Promise<Record<string, unknown>> =>
  (await import(absolutePath)) as Record<string, unknown>;

/** Scan an app root and return every primitive it declares, sorted for a stable diff. */
export async function scanApp(options: ScanOptions): Promise<AppManifest> {
  const importer = options.load ?? load;
  const entries: ManifestEntry[] = [];
  for (const pattern of options.globs ?? DEFAULT_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan({ cwd: options.root, absolute: true })) {
      if (file.includes('.test.') || file.includes('node_modules')) continue;
      const mod = await importer(file).catch(() => undefined);
      if (mod === undefined) continue;
      const rel = relative(options.root, file);
      for (const [exportName, value] of Object.entries(mod)) {
        const kind = readKind(value);
        if (kind === undefined || !isRecord(value)) continue;
        const base = {
          kind,
          name: exportName === 'config' && kind === 'route' ? routePathFor(rel) : exportName,
          file: rel,
          surface: surfaceFor(rel),
          meta: metaOf(value),
        };
        entries.push(kind === 'route' ? { ...base, path: routePathFor(rel) } : base);
      }
    }
  }
  entries.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  return { version: 1, buildId: buildIdFor(entries), entries };
}

/** Content-addressed build id: identical declarations produce an identical manifest. */
export function buildIdFor(entries: readonly ManifestEntry[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const entry of entries) hasher.update(`${entry.kind}:${entry.name}:${entry.file}`);
  return hasher.digest('hex').slice(0, 12);
}

export const countOf = (manifest: AppManifest, kind: PrimitiveKind): number =>
  manifest.entries.filter((entry) => entry.kind === kind).length;

export const routesOf = (manifest: AppManifest): readonly ManifestEntry[] =>
  manifest.entries.filter((entry) => entry.kind === 'route');
