// Single responsibility: the semconv histograms the framework records from its own events —
// statement duration, job duration, LLM token usage — as ONE subscriber on the instrumentation bus.
// Nothing records them inline: `subscribeSemconvMetrics()` is installed at boot, like an exporter.

import { isUltimateError } from './errors';
import { subscribe } from './instrument';
import type { AiLlmEvent, DbStatementEvent, JobPerformEvent } from './instrument-events';
import { SEMCONV_METRICS, SEMCONV_VALUES } from './instrument-semconv';
import { histogram } from './metrics';

/** semconv's advisory boundaries for `db.client.operation.duration`, seconds. */
const DB_DURATION_BOUNDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] as const;
/** semconv's advisory boundaries for `gen_ai.client.token.usage`. */
const TOKEN_BOUNDS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
] as const;

/**
 * Declared on the first subscribe, never at import: a declared instrument is a `# TYPE` line on
 * every `/metrics` scrape, and an app that never installs these must not advertise them.
 */
function instruments() {
  return {
    dbDuration: histogram(SEMCONV_METRICS.dbClientOperationDuration, {
      unit: 's',
      description: 'Duration of database client operations (semconv db.client.operation.duration)',
      bounds: DB_DURATION_BOUNDS,
    }),
    jobDuration: histogram(SEMCONV_METRICS.jobDuration, {
      unit: 's',
      description: 'Background job perform duration, by queue and outcome',
    }),
    tokenUsage: histogram(SEMCONV_METRICS.genAiClientTokenUsage, {
      unit: '{token}',
      description: 'Tokens used per LLM call, by token type (semconv gen_ai.client.token.usage)',
      bounds: TOKEN_BOUNDS,
    }),
  };
}

type Instruments = ReturnType<typeof instruments>;

/**
 * A BOUNDED operation label: the statement's leading keyword when it is one of these, else
 * `other`. The text itself never becomes a label — one series per distinct query is the
 * cardinality ceiling reached by lunchtime.
 */
const OPERATIONS: ReadonlySet<string> = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'set',
  'lock',
  'copy',
  'listen',
  'notify',
]);

export function dbOperationOf(text: string): string {
  const verb = /^\s*([a-z]+)\b/i.exec(text)?.[1]?.toLowerCase() ?? '';
  return OPERATIONS.has(verb) ? verb : 'other';
}

/** semconv `error.type`: the `X_*` code, else `_OTHER`. Absent on success. */
function errorType(error: unknown): string {
  return isUltimateError(error) ? error.code : '_OTHER';
}

function recordStatement({ dbDuration }: Instruments, event: DbStatementEvent): void {
  dbDuration.record(event.durationMs / 1000, {
    db_system_name: SEMCONV_VALUES.dbSystemPostgres,
    db_operation_name: dbOperationOf(event.text),
    ...(event.error === undefined ? {} : { error_type: errorType(event.error) }),
  });
}

function recordJob({ jobDuration }: Instruments, event: JobPerformEvent): void {
  jobDuration.record(event.durationMs / 1000, {
    queue: event.queue,
    outcome: event.error === undefined ? 'ok' : 'error',
  });
}

function recordTokens({ tokenUsage }: Instruments, event: AiLlmEvent): void {
  // A cache hit called no model and used no tokens: recording its counts would bill them twice.
  if (event.cacheHit) return;
  const labels = {
    gen_ai_operation_name: SEMCONV_VALUES.genAiOperationChat,
    gen_ai_provider_name: event.provider,
    gen_ai_request_model: event.model,
  };
  tokenUsage.record(event.inputTokens, {
    ...labels,
    gen_ai_token_type: SEMCONV_VALUES.genAiTokenInput,
  });
  tokenUsage.record(event.outputTokens, {
    ...labels,
    gen_ai_token_type: SEMCONV_VALUES.genAiTokenOutput,
  });
}

/**
 * Subscribe the semconv histograms. Returns the unsubscribe — wire it into the drain, or call it
 * between tests. Called twice it subscribes twice and every point is recorded twice, so boot calls
 * it ONCE.
 */
export function subscribeSemconvMetrics(): () => void {
  const declared = instruments();
  const offs = [
    subscribe('db.statement', (event) => recordStatement(declared, event.payload)),
    subscribe('job.perform', (event) => recordJob(declared, event.payload)),
    subscribe('ai.llm', (event) => recordTokens(declared, event.payload)),
  ];
  return () => {
    for (const off of offs) off();
  };
}
