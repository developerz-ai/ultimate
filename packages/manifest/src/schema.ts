// The manifest's own typed schema, plus the version field that lets a tool decide whether it
// can read a given file. `x.manifest.json` is a public contract consumed by agents, editors,
// and CI — a shape change without a version bump silently breaks all three.
//
// Every collection is `readonly` and every field is a plain JSON value: the manifest must
// round-trip through `JSON.stringify` without loss, because that is how it is stored.

/**
 * Bumped when a reader built for the previous version would be WRONG, not merely incomplete:
 * a field removed, retyped, or given a new meaning.
 *
 * Deliberately NOT bumped for a field that is only added. `isCompatible` is an equality check,
 * so a bump rejects every `x.manifest.json` in existence at once — and `diffManifest` classifies
 * a `manifestVersion` change as **breaking**, so a bump also demands a major version bump of
 * every APP that regenerates its manifest against the new framework. Charging every app a major
 * release for a field their readers never had to look at is a fix line that is not true.
 */
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

/** A declared bucket as the author wrote it — `toBucket`'s input, never its converted output. */
export interface RateLimitFact {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ActionFact {
  readonly name: string;
  readonly input: JsonValue;
  readonly output: JsonValue;
  /**
   * The policy's DISPLAY label — `post:publish` for a bare `can()`, but
   * `and(post:publish, org:administer)` for a composite. Read `permissions` to ask which grants a
   * policy actually asserts; matching on this string reports every composite as enforcing nothing.
   */
  readonly policy: string | null;
  /** Every permission the policy asserts, flattened through the combinators, deduped and sorted. */
  readonly permissions: readonly string[];
  readonly cacheInvalidates: readonly string[];
  /**
   * The declared rate limit; absent when the action declares none. A contract, not a tuning
   * knob: a client written against 1000/minute is broken by 5/minute as surely as by a narrowed
   * input, and the OpenAPI document already publishes the same pair as `x-ultimate.rateLimit` —
   * the manifest is the copy the gate reads, so without it the tightening passes clean.
   */
  readonly rateLimit?: RateLimitFact;
  readonly mcp: { readonly expose: boolean; readonly description?: string };
  readonly mutator?: boolean;
}

export interface QueryFact {
  readonly name: string;
  /** Optional: `QueryDescriptor` is schema-erased, so a live query may not expose one. */
  readonly input?: JsonValue;
  /** The policy's DISPLAY label — see `ActionFact.policy`, and read `permissions` to match on. */
  readonly policy: string | null;
  /** Every permission the policy asserts, flattened through the combinators, deduped and sorted. */
  readonly permissions: readonly string[];
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

/**
 * Whether a reader built for `MANIFEST_VERSION` can consume `manifest`.
 *
 * READABILITY, not completeness. An older file may simply lack a field this build publishes;
 * that is a reader's `?? []`, not an incompatibility. See `MANIFEST_VERSION` for when the answer
 * is allowed to become `false`.
 */
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
