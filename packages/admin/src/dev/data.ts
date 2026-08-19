// Every /_x panel reads from here, and every method is an introspection call — never a
// bespoke query. That is what makes the dashboard and the MCP dev server the same facts in
// two renderings: `--json` on a panel returns exactly what the panel drew.
//
// The framework introspection modules are reached through dynamic `import()` so the
// production graph never statically references them: /_x must not cost the app path a byte.

// Type-only, so it is erased: the introspection modules are still reached by dynamic
// `import()` below and /_x stays out of the production graph.
import type { JobState, StepStatus } from '@ultimat3/jobs';
import type { AdminActor, AdminAuthz } from '../authz';
import { DevSourceUnavailableError } from '../errors';
import type {
  BackfillFact,
  CacheEdgeFact,
  DevSources,
  DriftFact,
  InvalidationFact,
  JobDefFact,
  JobRunFact,
  JobStepFact,
  LiveQueryFact,
  LiveSubscriberFact,
  MailFact,
  ManifestFact,
  PolicyFact,
  QueueFact,
  RequestTrace,
  RouteFact,
  SqlResult,
  StatementLoopFact,
  TableFact,
  TaskFact,
} from './facts';

const empty = async <T>(value: T): Promise<T> => value;

/** Explicit fixtures. Tests and `x dev --offline` use this; it is not a fallback path. */
export function staticDevSources(facts: Partial<DevSources> = {}): DevSources {
  return {
    routes: facts.routes ?? ((): Promise<readonly RouteFact[]> => empty([])),
    traces: facts.traces ?? ((): Promise<readonly RequestTrace[]> => empty([])),
    statementLoops:
      facts.statementLoops ?? ((): Promise<readonly StatementLoopFact[]> => empty([])),
    liveQueries: facts.liveQueries ?? ((): Promise<readonly LiveQueryFact[]> => empty([])),
    subscribers: facts.subscribers ?? ((): Promise<readonly LiveSubscriberFact[]> => empty([])),
    jobDefs: facts.jobDefs ?? ((): Promise<readonly JobDefFact[]> => empty([])),
    queues: facts.queues ?? ((): Promise<readonly QueueFact[]> => empty([])),
    jobRuns: facts.jobRuns ?? ((): Promise<readonly JobRunFact[]> => empty([])),
    backfills: facts.backfills ?? ((): Promise<readonly BackfillFact[]> => empty([])),
    tasks: facts.tasks ?? ((): Promise<readonly TaskFact[]> => empty([])),
    tables: facts.tables ?? ((): Promise<readonly TableFact[]> => empty([])),
    drift: facts.drift ?? ((): Promise<readonly DriftFact[]> => empty([])),
    runSql:
      facts.runSql ?? ((): Promise<SqlResult> => empty({ columns: [], rows: [], elapsedMs: 0 })),
    mail: facts.mail ?? ((): Promise<readonly MailFact[]> => empty([])),
    cacheGraph: facts.cacheGraph ?? ((): Promise<readonly CacheEdgeFact[]> => empty([])),
    invalidations: facts.invalidations ?? ((): Promise<readonly InvalidationFact[]> => empty([])),
    policyMatrix: facts.policyMatrix ?? ((): Promise<readonly PolicyFact[]> => empty([])),
    manifest:
      facts.manifest ??
      ((): Promise<ManifestFact> => empty({ emitted: null, committed: null, diff: [] })),
  };
}

export interface DevSourceOptions {
  /** The app's authz. The policy matrix is computed through it, never re-derived. */
  readonly authz?: AdminAuthz;
  /** Actors the matrix is computed for. `x dev --actor` supplies these. */
  readonly actors?: readonly AdminActor[];
  /**
   * Facts no registry can produce on its own — request traces, caught mail, the read-only
   * SQL tool, the committed manifest. Unwired ones throw X_NOT_IMPLEMENTED with the exact
   * wiring line, rather than rendering an empty panel that reads as "nothing happened".
   */
  readonly hooks?: Partial<DevSources>;
  /**
   * Sample input per query name, so the live panel can show the SQL a query actually compiles
   * to. `@ultimat3/query`'s `QueryDescriptor` carries no SQL text — it depends on the input —
   * so a query with no sample here stays `sql: null` rather than an invented guess. `x dev
   * --actor` supplies these the same way it supplies `actors` for the policy matrix.
   */
  readonly sqlSamples?: Readonly<Record<string, unknown>>;
}

const unavailable = (source: string, panel: string): DevSourceUnavailableError =>
  new DevSourceUnavailableError({ source, panel });

const unwired = <T>(source: string, panel: string): (() => Promise<T>) => {
  // A rejected promise, never a synchronous throw: every caller's declared return type is
  // `Promise<T>`, and panels like `panel-cache.ts` degrade with `sources.invalidations().catch(…)`.
  // A synchronous throw fires while that expression is still being evaluated, before there is a
  // promise for `.catch` to attach to, so it escapes the panel's own degradation entirely.
  return (): Promise<T> => Promise.reject(unavailable(source, panel));
};

/** How many recent runs the jobs panel traces. A dev panel reads, it does not page. */
const RUN_WINDOW = 50;

/**
 * `JobState` and `StepStatus` are the queue's vocabulary; the panel renders its own.
 *
 * `cancelled` is `ok` and not `dead`, because the panel's four words split on "did this need
 * attention", not on "did the handler run". `panel-jobs.ts` reads `dead` as the dead-letter list
 * and `failed | dead` as the needs-attention list — a job an operator stopped on purpose belongs
 * in neither, and filing it under `dead` would put `x jobs retry` in front of a reader as the
 * remedy for a cancellation nobody wants resurrected.
 */
const RUN_STATUS: Readonly<Record<JobState, JobRunFact['status']>> = {
  ready: 'running',
  delayed: 'running',
  running: 'running',
  suspended: 'running',
  done: 'ok',
  cancelled: 'ok',
  failed: 'failed',
  dead: 'dead',
};

const STEP_STATUS: Readonly<Record<StepStatus, JobStepFact['status']>> = {
  completed: 'ok',
  sleeping: 'sleeping',
  waiting: 'pending',
  failed: 'failed',
};

/**
 * Every registry is read through its OWN descriptor type, not as an untyped bag. The bag was
 * defended here as tolerance — "a renamed field should show a blank cell rather than crash the
 * process an engineer is debugging with" — and what it actually bought was three panels that
 * were wrong for every row and could not go red: `route['render']`, `route['budget']`,
 * `route['revalidate']` and `job['idempotencyKey']` are names no descriptor has ever published,
 * so /_x reported every route as `stream` with no budget and every job as non-idempotent.
 *
 * The packages ship in lockstep at one version, so a renamed descriptor field is a rename this
 * file can be edited with — as a TYPECHECK failure naming the field, which is the tolerance
 * worth having. It costs the production graph nothing: `await import('@ultimat3/render')` is
 * typed by the module it resolves to, so /_x is still reached only through the dynamic import
 * and no descriptor type has to be named here at all. `published-keys.test.ts` is the other
 * half — it walks what the real registries EMIT, which a stale `dist/*.d.ts` would hide.
 */
export function defaultDevSources(opts: DevSourceOptions = {}): DevSources {
  const hooks = opts.hooks ?? {};

  const sources: DevSources = {
    async routes(): Promise<readonly RouteFact[]> {
      const { describeRoutes } = await import('@ultimat3/render');
      return describeRoutes().map((route) => ({
        path: route.path,
        // `RouteDescriptor` calls the render mode `mode`; the panel's own word is `render`, and
        // the two are bridged here, once. Reading `route['render']` answered `undefined` for
        // every route, so the fallback shipped — `stream` for the whole table, forever.
        render: route.mode,
        offline: route.offline,
        hydrate: route.hydrate,
        // A descriptor has no `handler`: the FILE is what names the row.
        handler: route.file,
        // Two flat fields on the descriptor, one nested bag on the fact — the panel's budget
        // check reads `budget.js`. Spread, never `js: undefined`: `exactOptionalPropertyTypes`.
        budget: {
          ...(route.budgetJs === null ? {} : { js: route.budgetJs }),
          ...(route.budgetLcp === null ? {} : { lcp: route.budgetLcp }),
        },
        // `revalidateTags`, already flattened to keys — never `revalidate.tags`, a shape the
        // descriptor does not have and which answered `[]` for every ISR route in the app.
        revalidateTags: route.revalidateTags,
      }));
    },

    traces: unwired<readonly RequestTrace[]>('traces', 'timeline'),

    // The verdicts belong to the one statement ledger `x dev` installs, so a host without it
    // refuses here rather than answering `[]`: an empty list claims "no N+1 in this request",
    // which is a different and unearned answer — the same argument `subscribers` and `mail` make.
    statementLoops: unwired<readonly StatementLoopFact[]>('statementLoops', 'timeline'),

    async liveQueries(): Promise<readonly LiveQueryFact[]> {
      const { describeQueries, describeSql, listQueries } = await import('@ultimat3/query');
      const queries = describeQueries();
      // `describeSql` is the one place that actually compiles a query to text — it needs a
      // sample input to do it, so a name with no entry in `sqlSamples` comes back `sql: null`
      // rather than the permanently-empty string this source used to answer for every query.
      // It takes the live `AnyQuery[]` targets (`listQueries()`), never the already-projected
      // `QueryDescriptor[]` this method also needs for `name`/`live`/`capability`.
      const sqlByName = new Map(
        (await describeSql(opts.sqlSamples ?? {}, listQueries())).map((entry) => [
          entry.query,
          entry.sql,
        ]),
      );
      return queries.map((query) => ({
        name: query.name,
        live: query.live,
        // `QueryDescriptor`'s permission field is named `capability`, not `policy` — this
        // fact keeps its own field named `policy` (that is the /_x rendering, not the registry).
        policy: query.capability,
        sql: sqlByName.get(query.name) ?? null,
      }));
    },

    subscribers: unwired<readonly LiveSubscriberFact[]>('subscribers', 'live'),

    async jobDefs(): Promise<readonly JobDefFact[]> {
      const { describeJobs } = await import('@ultimat3/jobs');
      return describeJobs().map((job) => ({
        name: job.name,
        queue: job.queue,
        steps: job.steps,
        retry: { attempts: job.retry.attempts, backoff: job.retry.backoff },
        // The descriptor's own boolean. `job['idempotencyKey']` was a read of the DEFINITION's
        // field on a descriptor that never carried it, so every job on the panel reported
        // non-idempotent — the opposite of what `job()` refuses to register without.
        idempotent: job.idempotent,
      }));
    },

    async queues(): Promise<readonly QueueFact[]> {
      const { inspectJobList, inspectQueues, jobDriver } = await import('@ultimat3/jobs');
      const driver = jobDriver();
      if (driver === undefined) throw unavailable('queues', 'jobs');
      const report = await inspectQueues(driver);
      // `stats()` counts states, and a failed job is one of them only until it is retried or
      // dead-lettered; the honest count comes from the job list, which needs introspection.
      const failed =
        driver.introspect === undefined ? [] : await inspectJobList(driver, { state: 'failed' });
      return report.queues.map((queue) => ({
        name: queue.queue,
        depth: queue.ready + queue.delayed,
        running: queue.running,
        failed: failed.filter((record) => record.queue === queue.queue).length,
        deadLetter: queue.dead,
      }));
    },

    async jobRuns(): Promise<readonly JobRunFact[]> {
      const { inspectJob, inspectJobList, jobDriver } = await import('@ultimat3/jobs');
      const driver = jobDriver();
      if (driver === undefined) throw unavailable('jobRuns', 'jobs');
      const records = await inspectJobList(driver, { limit: RUN_WINDOW });
      // One trace per run, because the panel's whole question is "which step failed?" — a
      // list row without its steps cannot answer it.
      const traces = await Promise.all(records.map((record) => inspectJob(driver, record.id)));
      return traces
        .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined)
        .map((trace) => ({
          id: trace.id,
          job: trace.name,
          queue: trace.queue,
          status: RUN_STATUS[trace.state],
          attempt: trace.attempt,
          steps: trace.steps.map((step) => ({
            name: step.name,
            status: STEP_STATUS[step.status],
            attempt: step.attempts,
            durationMs: step.durationMs ?? 0,
            error: step.error,
          })),
        }));
    },

    /**
     * The whole ledger, newest first — not just the passes in flight. `x jobs ls` reports the live
     * queue and says so; a panel is read to answer "has this backfill ever run here, and what did
     * it sweep", and the completed rows ARE that answer.
     *
     * `inspectBackfills` returns `[]` for a driver that ships no ledger, so only a process with no
     * queue at all refuses here — which is the same line `queues` and `jobRuns` draw.
     */
    async backfills(): Promise<readonly BackfillFact[]> {
      const { inspectBackfills, jobDriver } = await import('@ultimat3/jobs');
      const driver = jobDriver();
      if (driver === undefined) throw unavailable('backfills', 'jobs');
      return (await inspectBackfills(driver)).map((pass) => ({
        runId: pass.runId,
        name: pass.name,
        status: pass.status,
        rows: pass.rows,
        cursor: pass.cursor,
        startedAt: pass.startedAt,
        completedAt: pass.completedAt,
        durationMs: pass.durationMs,
        appVersion: pass.appVersion,
      }));
    },

    async tasks(): Promise<readonly TaskFact[]> {
      const { inspectManifest } = await import('@ultimat3/jobs');
      return inspectManifest().tasks.map((task) => ({
        name: task.name,
        cron: task.cron,
        tz: task.tz,
        nextRunAt: task.nextRun,
      }));
    },

    async tables(): Promise<readonly TableFact[]> {
      const { describeEntities } = await import('@ultimat3/entity');
      return describeEntities().map((entity) => ({
        name: entity.table,
        // `EntityDescription.columns` is a LIST of physical columns — money is already two
        // of them here. Reading it as a record produced a table whose columns were "0", "1".
        columns: entity.columns.map((column) => ({
          // The PHYSICAL name, which is the vocabulary a psql tab speaks.
          name: column.column,
          type: column.kind,
          nullable: !column.notNull,
        })),
      }));
    },

    /**
     * Unwired, and it has to be: drift is a COMPARISON — the entities this process declares
     * against the columns a database actually has — and `describeEntities()` is only one half of
     * it. This source used to read a `drift` key off `EntityDescription`, which has never had one,
     * so the panel answered `[]` for every app and every schema: "no drift" printed over a
     * database nobody looked at. Only a host holding the connection can answer (`x db migrate`'s
     * `checkDrift`), so it wires the hook or the panel says the check did not run.
     */
    drift: unwired<readonly DriftFact[]>('drift', 'db'),

    runSql: unwired<SqlResult>('runSql', 'db'),
    mail: unwired<readonly MailFact[]>('mail', 'mail'),

    /**
     * The tag graph is read through `dependentsOf`, one entity tag at a time: the cache owns
     * the graph, and /_x asking it per tag keeps the panel honest about what a real
     * invalidation would reach.
     */
    async cacheGraph(): Promise<readonly CacheEdgeFact[]> {
      const [{ dependentsOf }, { describeEntities }] = await Promise.all([
        import('@ultimat3/cache'),
        import('@ultimat3/entity'),
      ]);
      return describeEntities().map((entity) => ({
        tag: entity.name,
        dependents: dependentsOf([{ entity: entity.name }]).map((dependent) => ({
          kind: dependent.kind,
          id: dependent.id,
        })),
      }));
    },

    invalidations: unwired<readonly InvalidationFact[]>('invalidations', 'cache'),

    /**
     * The matrix is the app's own authz answering, actor by actor and permission by
     * permission. A panel that re-derived permissions would be a second authz system.
     */
    async policyMatrix(): Promise<readonly PolicyFact[]> {
      const authz = opts.authz;
      const actors = opts.actors ?? [];
      if (authz === undefined || actors.length === 0) {
        // Neither is a `hooks` entry — both are `DevSourceOptions` fields — so the rendered fix
        // has to spell a real `defaultDevSources({ authz, actors })` call, not the default
        // `hooks: { <source> }` phrasing (`{ authz + actors }` is not valid syntax).
        throw new DevSourceUnavailableError({
          source: 'authz + actors',
          panel: 'policy',
          wiring: '{ authz, actors }',
        });
      }
      const { describeActions } = await import('@ultimat3/action');
      // `permissions`, NOT `capability`. `capability` is the policy's DISPLAY label and
      // `action.ts` says so: a composite renders as `and(post:read, org:member)`, which is not a
      // permission and can never be granted — so every composite-guarded action was a
      // permanently-denied row, and an operator read a real grant as missing. `permissions` is
      // the flattened list a grant is actually matched against. This is the SECOND time the two
      // were confused: `x policy list` reported the same actions as unenforced for the same
      // reason, and `ActionDescriptor.permissions` carries that history in its own doc comment.
      const permissions = [
        ...new Set(describeActions().flatMap((action) => action.permissions)),
      ].filter((permission) => permission !== '');

      return actors.flatMap((actor) =>
        permissions.map((permission) => {
          const decision = authz.decide({ permission, actor });
          return {
            permission,
            actorId: actor.id,
            allowed: decision.allowed,
            trace: decision.trace,
          };
        }),
      );
    },

    manifest: unwired<ManifestFact>('manifest', 'manifest'),
  };

  return { ...sources, ...hooks };
}
