// Wires the framework's description functions into `ManifestSources`.
//
// Split from `build.ts` so `buildManifest` stays a pure function of its input — the
// determinism guarantee is much easier to trust (and to test) when the builder cannot reach
// a global registry. Routes and policies are supplied by the caller: the route table lives
// in `@ultimat3/render`, which is this same tier.

import { describeActions } from '@ultimat3/action';
import { describeEntities } from '@ultimat3/entity';
import { describeJobs } from '@ultimat3/jobs';
import { describeQueries } from '@ultimat3/query';
import type { ManifestSources } from './build';
import type { ErrorCodeFact, JsonValue, PolicyFact, RouteFact, TaskFact } from './schema';

export interface FrameworkSourcesInput {
  readonly app: { readonly name: string; readonly version: string };
  /** From `@ultimat3/render`'s `describeRoutes()`. */
  readonly routes?: readonly RouteFact[];
  /** Assembled per app from its policy modules. */
  readonly policies?: readonly PolicyFact[];
  readonly tasks?: readonly TaskFact[];
  readonly locales?: readonly string[];
  /** Each package's `*_ERROR_CODES`, flattened by the CLI. */
  readonly errorCodes?: readonly ErrorCodeFact[];
}

/**
 * Read every primitive registry and combine with the caller-supplied facts. The `describe*`
 * functions return the framework's own descriptors; they are narrowed to the manifest's
 * fact shapes here, which is the one place that mapping lives.
 */
/**
 * A `JsonSchemaObject` is JSON by construction, but TypeScript will not assign an interface
 * to an index-signature type. Converted in exactly one place rather than widening every fact.
 */
const asJson = (value: object): JsonValue => value as JsonValue;

export function frameworkSources(input: FrameworkSourcesInput): ManifestSources {
  return {
    app: input.app,
    routes: input.routes ?? [],
    policies: input.policies ?? [],
    tasks: input.tasks ?? [],
    locales: input.locales ?? [],
    errorCodes: input.errorCodes ?? [],
    // Projected field by field, never cast: the primitive registries own richer shapes
    // than the manifest publishes, and a cast would silently rot when either side moves.
    entities: describeEntities().map((entity) => ({
      name: entity.name,
      table: entity.table,
      columns: entity.columns.map((column) => ({
        name: column.column,
        type: column.kind,
        nullable: !column.notNull,
        primaryKey: column.primaryKey,
        ...(column.references === null ? {} : { references: column.references }),
      })),
      invariants: entity.invariants.map((invariant) => invariant.name),
    })),
    actions: describeActions().map((action) => ({
      name: action.name,
      input: asJson(action.input),
      output: asJson(action.output),
      policy: action.capability,
      permissions: action.permissions,
      cacheInvalidates: action.invalidates,
      // Written only when declared, exactly like `mcp.description`: absence already reads as
      // "no limit", and the descriptor's `null` is not a JSON fact worth a line per action.
      ...(action.rateLimit === null ? {} : { rateLimit: action.rateLimit }),
      mcp: {
        expose: action.mcp.expose,
        ...(action.mcp.description === null ? {} : { description: action.mcp.description }),
      },
      // Written only when true, exactly like `mcp.description`: `ActionFact.mutator` is optional,
      // so absence already reads as "a plain action", and a `false` on every other action would
      // be bytes added to a file that is reviewed by hand for no fact gained.
      ...(action.mutator ? { mutator: true } : {}),
    })),
    queries: describeQueries().map((query) => ({
      name: query.name,
      policy: query.capability,
      permissions: query.permissions,
      live: query.live,
      // Written only when declared — `null` is the descriptor's "the read named none", and an
      // empty list is refused at `query()`, so absence carries the whole meaning.
      ...(query.subscribes === null ? {} : { subscribes: query.subscribes }),
      cacheTags: query.tags,
    })),
    jobs: describeJobs().map((job) => ({
      name: job.name,
      input: asJson(job.input),
      queue: job.queue,
      retry: { attempts: job.retry.attempts, backoff: job.retry.backoff },
      // Empty by construction, not dropped by the projection: a step name is chosen inside
      // `run()` at execution time, so no static reader can know it. `x jobs show` reports the
      // steps an actual run recorded.
      steps: job.steps,
    })),
  };
}
