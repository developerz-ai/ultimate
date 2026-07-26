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
import type { ManifestSources } from './build.ts';
import type {
  ActionFact,
  EntityFact,
  ErrorCodeFact,
  JobFact,
  PolicyFact,
  QueryFact,
  RouteFact,
  TaskFact,
} from './schema.ts';

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
export function frameworkSources(input: FrameworkSourcesInput): ManifestSources {
  return {
    app: input.app,
    routes: input.routes ?? [],
    policies: input.policies ?? [],
    tasks: input.tasks ?? [],
    locales: input.locales ?? [],
    errorCodes: input.errorCodes ?? [],
    entities: describeEntities() as readonly EntityFact[],
    actions: describeActions() as readonly ActionFact[],
    queries: describeQueries() as readonly QueryFact[],
    jobs: describeJobs() as readonly JobFact[],
  };
}
