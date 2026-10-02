// The manifest's own typed schema, plus the version field that lets a tool decide whether it
// can read a given file. `x.manifest.json` is a public contract consumed by agents, editors,
// and CI — a shape change without a version bump silently breaks all three.
//
// Every collection is `readonly` and every field is a plain JSON value: the manifest must
// round-trip through `JSON.stringify` without loss, because that is how it is stored.

// The route vocabulary is `@ultimat3/core`'s, at tier 0. It is IMPORTED rather than restated even
// though every other field here is a plain literal: the manifest's `render` field means the same
// thing as the route's, and two spellings of one closed set is what `'spa'` escaped through.
import type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';

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

/** One scope of an admin list: a tab, by name. */
export interface AdminScopeFact {
  readonly name: string;
  /** What a bare list URL reads. At most one per resource. */
  readonly default: boolean;
  /** The tab shows a row count — one extra query per list page. */
  readonly count: boolean;
}

/** One titled group of an admin detail page or form. `title` is an i18n key; `null` untitled. */
export interface AdminSectionFact {
  readonly title: string | null;
  readonly fields: readonly string[];
}

/**
 * One admin action: its button, its batch bar entry and its ONE MCP tool. `when` narrows which rows
 * it applies to; `batch` puts it in the bar and gives the tool `ids`; past `threshold` rows a batch
 * is queued as `admin.batch` jobs instead of run in the request.
 */
export interface AdminActionFact {
  readonly name: string;
  readonly permission: string;
  readonly destructive: boolean;
  readonly input: boolean;
  readonly when: boolean;
  readonly batch: boolean;
  readonly threshold: number | null;
}

/** One resource of a generated admin: what its list answers, and whether a row scope narrows it. */
export interface AdminResourceFact {
  readonly entity: string;
  /** Mount-relative: `/posts`. */
  readonly path: string;
  /** The fields a list URL's `f.<field>` and the MCP list tool's `where` may name, in bar order. */
  readonly filters: readonly string[];
  /** The fields `?sort=` may name. */
  readonly sorts: readonly string[];
  /** Tab order. */
  readonly scopes: readonly AdminScopeFact[];
  /** `rows` is declared: every read of the resource is narrowed per actor. */
  readonly rowScoped: boolean;
  /** The detail page's groups, drawing order; undeclared fields are the last, default one. */
  readonly sections: readonly AdminSectionFact[];
  /** The create and edit form's groups, the same way. */
  readonly formGroups: readonly AdminSectionFact[];
  /** `hasMany` relations drawn on the detail page as the related resource's own list. */
  readonly related: readonly string[];
  /** Declaration order — the order the buttons are drawn in. */
  readonly actions: readonly AdminActionFact[];
}

/** One route `defineAdmin()` mounts — no page file declares it. */
export interface AdminRouteFact {
  readonly url: string;
  readonly view: string;
  readonly entity: string | null;
  /** Every permission the screen decides on, coarse gate first. A pair, not a set. */
  readonly permissions: readonly string[];
}

/** One generated admin, as `defineAdmin()` derived it. */
export interface AdminFact {
  readonly basePath: string;
  /** The audit log the admin writes: `memory` forgets at every restart; `postgres` is the record. */
  readonly audit: string;
  readonly resources: readonly AdminResourceFact[];
  readonly routes: readonly AdminRouteFact[];
}

export interface ColumnFact {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey?: boolean;
  readonly references?: string;
  /**
   * The column has a declared default (a value, `defaultNow()`, a generated key). Written only when
   * true, so a column without one reads as it always did. Adding a NOT NULL column WITH a default
   * is additive — every existing row takes the default — and was classed breaking without this.
   */
  readonly hasDefault?: boolean;
  /**
   * The column is `.sealed()`: stored as ciphertext, absent from every output. `'lookup'` is the
   * deterministic form, matchable by equality. Written only when sealed, so a column that is not
   * reads as it always did — and an agent reading the manifest can tell a field it will never be
   * sent from one that is merely missing.
   */
  readonly sealed?: 'opaque' | 'lookup';
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
  /**
   * The relations a live read is patched from, as the query DECLARED them — absent when it
   * declared none, exactly like `ActionFact.rateLimit`, because an empty array on every plain
   * read is bytes in a hand-reviewed file for no fact gained.
   *
   * The reason this fact exists: `x db gen` has to grant `REPLICA IDENTITY FULL` to those tables
   * or `@ultimat3/realtime` refuses the subscription, and `@ultimat3/cli` cannot derive them —
   * the relation name lives inside the query's `sql:` callback, which no generator can invoke
   * without valid input. So the manifest is the one place a tier-1 generator can read it.
   */
  readonly subscribes?: readonly string[];
  readonly cacheTags: readonly string[];
}

/**
 * A declared realtime `channel()`: what a client subscribes by, and what its policy requires.
 * Its NAME and PARAMS are the wire contract — a client spells neither, it derives both from the
 * declaration — so a change to either is breaking for every page built against the old ones.
 */
export interface ChannelFact {
  readonly name: string;
  readonly params: readonly string[];
  /** The query a client re-reads on `replay-gap`. */
  readonly catchUp: string;
  /** Record types (entity names) the channel carries. */
  readonly records: readonly string[];
  readonly events: boolean;
  /** The policy's label. Never null since 22.0.0 — `channel()` requires a policy. */
  readonly policy: string;
  readonly permissions: readonly string[];
}

export interface JobFact {
  readonly name: string;
  readonly input: JsonValue;
  readonly queue: string;
  readonly retry: { readonly attempts: number; readonly backoff: string };
  readonly steps: readonly string[];
  /**
   * The job's fleet-wide cap, present only when it declares one. `keyed: true` says `limit` holds
   * per `concurrency.key(input)` — "one run per account" — rather than for the whole job, and
   * `whenBusy` is what a claim over it does (`null` for a plain number, which always waits).
   * Optional for `channels`' reason: a manifest written before this existed is "no cap known".
   */
  readonly concurrency?: {
    readonly limit: number;
    readonly keyed: boolean;
    readonly whenBusy: string | null;
  };
  /** Present, and `true`, only when the job declares an `onSettled` hook. */
  readonly onSettled?: true;
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
  /**
   * App name and semver from the app's `package.json` (`app-manifest.ts`'s `appIdentity`), never
   * from `app.config.ts` — `AppConfig` has no `version` field and `defineConfig`
   * excess-property-checks its literal, so an instruction to edit one there fails typecheck.
   * Drives the breaking-change gate.
   */
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
  /**
   * Optional to a READER only: a file written before channels were projected has none, and that
   * is "no channels", never an unreadable manifest. `buildManifest` always writes it.
   */
  readonly channels?: readonly ChannelFact[];
  /**
   * The generated admins the app declares, each with its resources and mounted routes. Optional to
   * a READER only, exactly as `channels` is: a file written before admins were projected has none.
   * `buildManifest` always writes it — `[]` for an app with no admin.
   */
  readonly admin?: readonly AdminFact[];
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

/**
 * Every top-level section the type declares as an array. Checked, never assumed — and exported
 * because `diff.test.ts` walks it to prove each one is classified: a section added here with no
 * rule in the diff is a failing test, which is the enforcement half of "a new manifest field ⇒ a
 * diff rule for it".
 */
export const ARRAY_SECTIONS = [
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

/**
 * Structural check for a value read off disk, before it is trusted as a `Manifest`.
 *
 * EVERY top-level key, because the cast covers all of them: this checked five and cast the rest,
 * and `diffManifest` then read `before.queries`, `before.jobs`, `before.permissions` and
 * `before.locales` with no guard — so a section a hand-trimmed or truncated file happened not to
 * carry surfaced as a bare `TypeError` out of the contract gate, two calls from the file that
 * caused it. Rejecting here makes it `X_MANIFEST_DRIFT`, which names the file and the command.
 *
 * The individual FACTS inside a section are deliberately not walked: a manifest written before a
 * field existed is still readable, which is the compatibility rule `MANIFEST_VERSION` owns and
 * `build.test.ts`'s `shape compatibility` case pins.
 */
export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['manifestVersion'] !== 'number' || typeof m['buildId'] !== 'string') return false;
  for (const section of ARRAY_SECTIONS) if (!Array.isArray(m[section])) return false;
  // Absent is a pre-channel file and readable; present and not an array is a damaged one.
  if (m['channels'] !== undefined && !Array.isArray(m['channels'])) return false;
  if (m['admin'] !== undefined && !Array.isArray(m['admin'])) return false;
  return isAppIdentity(m['app']);
}

/** `app` drives the semver gate, so a missing or non-string version is not a manifest. */
function isAppIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const app = value as Record<string, unknown>;
  return typeof app['name'] === 'string' && typeof app['version'] === 'string';
}
