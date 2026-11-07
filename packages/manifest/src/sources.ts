// Wires the framework's description functions into `ManifestSources`.
//
// Split from `build.ts` so `buildManifest` stays a pure function of its input — the
// determinism guarantee is much easier to trust (and to test) when the builder cannot reach
// a global registry. Routes and policies are supplied by the caller: the route table lives
// in `@ultimat3/render`, which is this same tier.

import {
  actionHttpPinOf,
  apiDeclaration,
  describeActions,
  getAction,
  jsonSchemaOf,
} from '@ultimat3/action';
import { describeEntities, registeredEntities, sealedFields } from '@ultimat3/entity';
import { describeJobs, registeredConsumers, registeredSubjects } from '@ultimat3/jobs';
import { describeQueries, getQuery, queryHttpPinOf } from '@ultimat3/query';
import { describeChannels } from '@ultimat3/realtime/server';
import { toWireOutputSchema } from '@ultimat3/schema';
import type { ManifestSources } from './build';
import type {
  AdminFact,
  ErrorCodeFact,
  JsonValue,
  PolicyFact,
  RouteFact,
  TaskFact,
} from './schema';
import type { SubjectFact } from './schema-subjects';
import { declaredAdmins } from './sources-admin';

export interface FrameworkSourcesInput {
  readonly app: { readonly name: string; readonly version: string };
  /** From `@ultimat3/render`'s `describePages()`. */
  readonly routes?: readonly RouteFact[];
  /** Assembled per app from its policy modules. */
  readonly policies?: readonly PolicyFact[];
  readonly tasks?: readonly TaskFact[];
  readonly locales?: readonly string[];
  /** Each package's `*_ERROR_CODES`, flattened by the CLI. */
  readonly errorCodes?: readonly ErrorCodeFact[];
  /**
   * The app's generated admins. Omitted, they are read off the process's own declarations
   * (`sources-admin.ts`) — the one section a caller does not have to inject.
   */
  readonly admin?: readonly AdminFact[];
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

/** `describeQueries` and `getQuery` read one registry, so the handle is always there. */
const queryInput = (name: string): { readonly input?: JsonValue } => {
  const handle = getQuery(name);
  return handle === undefined ? {} : { input: asJson(jsonSchemaOf(handle.input)) };
};

/**
 * The row the read's OpenAPI operation and MCP tool publish, through the one narrowing both call.
 * Absent when none is declared or it cannot be introspected: there is no fact to write.
 */
const queryRows = (name: string): { readonly rows?: JsonValue } => {
  const row = toWireOutputSchema(getQuery(name)?.rows);
  return row === undefined ? {} : { rows: asJson(row) };
};

/**
 * A pinned `http: { path, method }`, written only when pinned: an unpinned primitive's URL is the
 * style's derivation, which the manifest never carried, so absence keeps every fact's bytes.
 */
const actionHttp = (name: string) => {
  const target = getAction(name);
  const pin = target === undefined ? undefined : actionHttpPinOf(target);
  return pin === undefined ? {} : { http: pin };
};

const queryHttp = (name: string) => {
  const target = getQuery(name);
  const pin = target === undefined ? undefined : queryHttpPinOf(target);
  return pin === undefined ? {} : { http: pin };
};

/** Absent stays absent: only a sealed column carries the field. */
const sealedFact = (
  how: 'opaque' | 'lookup' | undefined,
): { readonly sealed?: 'opaque' | 'lookup' } => (how === undefined ? {} : { sealed: how });

/**
 * `<entity name>` -> `<physical column>` -> how it is sealed. Read off the declarations rather than
 * `$describe()`, which is the DDL's projection: sealing changes no DDL, so it is not on it, and a
 * column becoming sealed must not move the schema hash a migration is checked against.
 */
function sealedColumns(): ReadonlyMap<string, ReadonlyMap<string, 'opaque' | 'lookup'>> {
  return new Map(
    registeredEntities().map((entry) => [
      entry.name,
      new Map(
        // `core` is absent on a hand-registered entry, which declares no columns to seal.
        (entry.core === undefined ? [] : sealedFields(entry.core)).map((field) => [
          field.column,
          field.lookup ? ('lookup' as const) : ('opaque' as const),
        ]),
      ),
    ]),
  );
}

/**
 * One `defineSubject()`, projected: each treatment's KIND and its columns or reason — never the
 * anonymized values, which are code (a function, a constant) and not a contract fact.
 */
function subjectFact(subject: ReturnType<typeof registeredSubjects>[number]): SubjectFact {
  const tables = Object.entries(subject.init.tables).map(([entity, treatment]) =>
    treatment === 'delete'
      ? { entity, treatment: 'delete' as const }
      : 'retain' in treatment
        ? { entity, treatment: 'retain' as const, reason: treatment.retain }
        : { entity, treatment: 'anonymize' as const, columns: Object.keys(treatment.anonymize) },
  );
  const links = Object.entries(subject.init.columns ?? {}).map(([entity, column]) => ({
    entity,
    column,
  }));
  return {
    entity: subject.entity,
    batch: subject.batch,
    tables,
    targets: (subject.init.targets ?? []).map((entry) =>
      'target' in entry
        ? { name: entry.target.name, retained: true }
        : { name: entry.name, retained: false },
    ),
    ...(links.length === 0 ? {} : { links }),
  };
}

export function frameworkSources(input: FrameworkSourcesInput): ManifestSources {
  const sealed = sealedColumns();
  return {
    app: input.app,
    routes: input.routes ?? [],
    policies: input.policies ?? [],
    tasks: input.tasks ?? [],
    locales: input.locales ?? [],
    errorCodes: input.errorCodes ?? [],
    admin: input.admin ?? declaredAdmins(),
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
        ...(column.hasDefault ? { hasDefault: true } : {}),
        ...(column.references === null ? {} : { references: column.references }),
        ...sealedFact(sealed.get(entity.name)?.get(column.column)),
      })),
      invariants: entity.invariants.map((invariant) => invariant.name),
      ...(entity.shared === undefined ? {} : { shared: entity.shared }),
      ...(entity.scan === undefined ? {} : { scan: entity.scan }),
      ...(entity.view === undefined || entity.view === null
        ? {}
        : { view: { materialized: entity.view.materialized === true } }),
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
      // A per-call limit has no fixed pair, and dropping its window read as "no rate limit".
      ...(action.rateLimitPerCall === null
        ? {}
        : { rateLimitPerCall: { windowMs: action.rateLimitPerCall.windowMs } }),
      // The same rule: absent reads as "no meter"; a per-call limit keeps its `null` (`MeterFact`).
      ...(action.meter === null ? {} : { meter: action.meter }),
      mcp: {
        expose: action.mcp.expose,
        ...(action.mcp.description === null ? {} : { description: action.mcp.description }),
      },
      // Written only when true, exactly like `mcp.description`: `ActionFact.mutator` is optional,
      // so absence already reads as "a plain action", and a `false` on every other action would
      // be bytes added to a file that is reviewed by hand for no fact gained.
      ...(action.mutator ? { mutator: true } : {}),
      // Written when declared, sorted; `null` is the descriptor's "declares none" (an open list).
      ...(action.errors === null ? {} : { errors: [...action.errors].sort() }),
      ...actionHttp(action.name),
    })),
    queries: describeQueries().map((query) => ({
      name: query.name,
      // The handle's own schema, projected exactly as an action's is: the descriptor is
      // schema-erased, and without this `diffQueries`' input compare never fired on a real app.
      ...queryInput(query.name),
      policy: query.capability,
      permissions: query.permissions,
      live: query.live,
      // Written only when declared — `null` is the descriptor's "the read named none", and an
      // empty list is refused at `query()`, so absence carries the whole meaning.
      ...(query.subscribes === null ? {} : { subscribes: query.subscribes }),
      cacheTags: query.tags,
      // Written only when true — the reason `mutator` is: absence already means "answers rows".
      ...(query.download ? { download: true as const } : {}),
      ...queryRows(query.name),
      ...(query.errors === null ? {} : { errors: [...query.errors].sort() }),
      ...queryHttp(query.name),
    })),
    // The prefix and the cut, field by field: `resolveToken` is a function, and the rest of a mount
    // decides nothing about whether a held token's call still finds its route.
    mounts: (apiDeclaration().http?.mounts ?? []).map((mount) => ({
      prefix: mount.prefix,
      scopes: mount.scopes,
    })),
    // Already the fact's shape, sorted and flattened by `describeChannels` — projected field by
    // field all the same, for the reason above.
    channels: describeChannels().map((channel) => ({
      name: channel.name,
      params: channel.params,
      catchUp: channel.catchUp,
      records: channel.records,
      events: channel.events,
      policy: channel.policy,
      permissions: channel.permissions,
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
      // Absent, never `null`, for a job with no cap: a row gains the key the day its job declares
      // one, so adding this fact moved no committed manifest but the ones it is a fact about.
      ...(job.concurrency === null
        ? {}
        : {
            concurrency: {
              limit: job.concurrency.limit,
              keyed: job.concurrency.keyed,
              whenBusy: job.concurrency.whenBusy,
            },
          }),
      // The same rule: only a job that declares the hook carries the key.
      ...(job.onSettled ? { onSettled: true as const } : {}),
    })),
    // Field by field, for the reason above: `kind` is the declaration's tag, not a fact.
    consumers: registeredConsumers().map((consumer) => ({
      name: consumer.name,
      queue: consumer.queue,
      supervisor: consumer.supervisor,
      arm: consumer.arm,
      rearm: consumer.rearm,
      batch: consumer.batch,
      lags: consumer.lags,
    })),
    subjects: registeredSubjects().map(subjectFact),
  };
}
