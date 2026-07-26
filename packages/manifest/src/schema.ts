// The manifest's own typed schema, plus the version field that lets a tool decide whether it
// can read a given file. `x.manifest.json` is a public contract consumed by agents, editors,
// and CI — a shape change without a version bump silently breaks all three.
//
// Every collection is `readonly` and every field is a plain JSON value: the manifest must
// round-trip through `JSON.stringify` without loss, because that is how it is stored.

/** Bumped when the manifest SHAPE changes, not when an app's contents change. */
export const MANIFEST_VERSION = 1;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';
export type OfflineStrategy = 'precache' | 'runtime' | 'network-only';
export type HydrateStrategy = 'idle' | 'visible' | 'interaction' | 'never';

export interface RouteFact {
  readonly url: string;
  readonly render: RenderMode;
  readonly offline?: OfflineStrategy;
  readonly hydrate?: HydrateStrategy;
  readonly revalidateTags?: readonly string[];
  readonly budget?: { readonly js?: string; readonly lcp?: number };
  /** Which surface the route lives in — `site` may never import from `app`. */
  readonly surface?: 'site' | 'app' | 'api';
}

export interface ColumnFact {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey?: boolean;
  readonly references?: string;
}

export interface EntityFact {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly ColumnFact[];
  /** Named invariants, so an agent can see the rules without reading the migration. */
  readonly invariants: readonly string[];
}

export interface ActionFact {
  readonly name: string;
  readonly input: JsonValue;
  readonly output: JsonValue;
  /** Permission string the policy asserts, e.g. `post:publish`. */
  readonly policy: string | null;
  readonly cacheInvalidates: readonly string[];
  readonly mcp: { readonly expose: boolean; readonly description?: string };
  readonly mutator?: boolean;
}

export interface QueryFact {
  readonly name: string;
  readonly input: JsonValue;
  readonly policy: string | null;
  readonly live: boolean;
  readonly cacheTags: readonly string[];
}

export interface JobFact {
  readonly name: string;
  readonly input: JsonValue;
  readonly queue: string;
  readonly retry: { readonly attempts: number; readonly backoff: string };
  readonly steps: readonly string[];
}

export interface TaskFact {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly enqueues: readonly string[];
}

export interface PolicyFact {
  readonly permission: string;
  readonly description?: string;
  /** Where this policy is enforced. One policy, N surfaces — this lists them. */
  readonly enforcedIn: readonly string[];
}

export interface ErrorCodeFact {
  readonly code: string;
  readonly package: string;
}

export interface Manifest {
  /** Shape version. A reader checks this before anything else. */
  readonly manifestVersion: number;
  /** App name and semver from `app.config.ts`. Drives the breaking-change gate. */
  readonly app: { readonly name: string; readonly version: string };
  /**
   * Content hash of everything below. Deterministic — NOT a timestamp and not a git sha, so
   * two builds of the same tree produce the same manifest byte-for-byte.
   */
  readonly buildId: string;
  readonly routes: readonly RouteFact[];
  readonly entities: readonly EntityFact[];
  readonly actions: readonly ActionFact[];
  readonly queries: readonly QueryFact[];
  readonly jobs: readonly JobFact[];
  readonly tasks: readonly TaskFact[];
  readonly policies: readonly PolicyFact[];
  readonly permissions: readonly string[];
  readonly locales: readonly string[];
  readonly errorCodes: readonly ErrorCodeFact[];
}

/** Whether a reader built for `MANIFEST_VERSION` can consume `manifest`. */
export function isCompatible(manifest: { manifestVersion: number }): boolean {
  return manifest.manifestVersion === MANIFEST_VERSION;
}

/** Structural check for a value read off disk, before it is trusted as a `Manifest`. */
export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['manifestVersion'] === 'number' &&
    typeof m['buildId'] === 'string' &&
    Array.isArray(m['actions']) &&
    Array.isArray(m['routes']) &&
    Array.isArray(m['entities'])
  );
}
