// The facts a /_x panel may read: one shape per introspection call. Kept apart from the
// sources that produce them so a panel imports the shape it renders and nothing else.

export interface RouteFact {
  readonly path: string;
  readonly render: string;
  readonly offline: string;
  readonly hydrate: string;
  readonly handler: string;
  readonly budget: { readonly js?: string; readonly lcp?: number };
  readonly revalidateTags: readonly string[];
  readonly hasMeta: boolean;
}

/**
 * `http` is the request span itself — the root every other span hangs off. Without it the flame
 * has no depth-0 row to nest under, and a host would have to file the request under one of the
 * things it contains.
 */
export type SpanKind = 'http' | 'sql' | 'cache' | 'action' | 'policy' | 'job' | 'render';

export interface TimelineSpan {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: SpanKind;
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly detail: string;
}

export interface RequestTrace {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly spans: readonly TimelineSpan[];
}

/**
 * One statement shape repeated inside one request past the detector's threshold — a verdict,
 * already carrying the error a host renders. The count, the attribution and the suppression rule
 * are the detector's (`x dev`'s statement ledger); nothing here re-derives them from the spans,
 * because a second count blind to `expectedQueryLoop` would disagree with the one that warns.
 */
export interface StatementLoopFact {
  /** The request the loop happened in — how a trace and its verdicts are matched up. */
  readonly requestId: string;
  /** `X_N_PLUS_ONE_QUERY` or `X_N_PLUS_ONE_WRITE`. */
  readonly code: string;
  readonly cause: string;
  /** Runnable, and the whole point: the `preload`/`insertAll` line that ends the loop. */
  readonly fix: string;
  readonly docs: string | null;
  /** What repeated: `members.findById` when a repository sent it, else the statement's own text. */
  readonly subject: string;
  readonly count: number;
  /** One of the statements, verbatim. */
  readonly sample: string;
}

export interface LiveSubscriberFact {
  readonly id: string;
  readonly query: string;
  readonly actorId: string;
  readonly matched: boolean;
  /** The matcher's decision, line by line. The whole point of the panel. */
  readonly trace: readonly string[];
  readonly rows: number;
  readonly lastDeliveryAt: string | null;
}

export interface LiveQueryFact {
  readonly name: string;
  readonly live: boolean;
  readonly policy: string;
  /** `null` when no sample input was supplied for this query — SQL depends on arguments. */
  readonly sql: string | null;
}

export interface JobDefFact {
  readonly name: string;
  readonly queue: string;
  readonly steps: readonly string[];
  readonly retry: { readonly attempts: number; readonly backoff: string };
  readonly idempotent: boolean;
}

export interface QueueFact {
  readonly name: string;
  readonly depth: number;
  readonly running: number;
  readonly failed: number;
  readonly deadLetter: number;
}

export interface JobStepFact {
  readonly name: string;
  readonly status: 'ok' | 'running' | 'failed' | 'sleeping' | 'pending';
  readonly attempt: number;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface JobRunFact {
  readonly id: string;
  readonly job: string;
  readonly queue: string;
  readonly status: 'ok' | 'running' | 'failed' | 'dead';
  readonly attempt: number;
  readonly steps: readonly JobStepFact[];
}

export interface TaskFact {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly nextRunAt: string | null;
}

export interface ColumnFact {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface TableFact {
  readonly name: string;
  readonly columns: readonly ColumnFact[];
}

export interface DriftFact {
  readonly table: string;
  readonly column: string | null;
  readonly issue: string;
}

export interface SqlResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly elapsedMs: number;
}

export interface MailFact {
  readonly id: string;
  readonly to: string;
  readonly subject: string;
  readonly locale: string;
  readonly html: string;
  readonly text: string;
  readonly sentAt: string;
}

export interface CacheEdgeFact {
  readonly tag: string;
  readonly dependents: readonly { readonly kind: string; readonly id: string }[];
}

export interface InvalidationFact {
  readonly at: string;
  readonly tags: readonly string[];
  readonly busted: readonly string[];
  readonly source: string;
}

export interface PolicyFact {
  readonly permission: string;
  readonly actorId: string;
  readonly allowed: boolean;
  readonly trace: readonly string[];
}

export interface ManifestFact {
  readonly emitted: unknown;
  readonly committed: unknown;
  readonly diff: readonly {
    readonly path: string;
    readonly emitted: unknown;
    readonly committed: unknown;
  }[];
}

/** The whole introspection surface /_x is allowed to read. Nothing else is in scope. */
export interface DevSources {
  routes(): Promise<readonly RouteFact[]>;
  traces(): Promise<readonly RequestTrace[]>;
  statementLoops(): Promise<readonly StatementLoopFact[]>;
  liveQueries(): Promise<readonly LiveQueryFact[]>;
  subscribers(): Promise<readonly LiveSubscriberFact[]>;
  jobDefs(): Promise<readonly JobDefFact[]>;
  queues(): Promise<readonly QueueFact[]>;
  jobRuns(): Promise<readonly JobRunFact[]>;
  tasks(): Promise<readonly TaskFact[]>;
  tables(): Promise<readonly TableFact[]>;
  drift(): Promise<readonly DriftFact[]>;
  runSql(sql: string): Promise<SqlResult>;
  mail(): Promise<readonly MailFact[]>;
  cacheGraph(): Promise<readonly CacheEdgeFact[]>;
  invalidations(): Promise<readonly InvalidationFact[]>;
  policyMatrix(): Promise<readonly PolicyFact[]>;
  manifest(): Promise<ManifestFact>;
}
