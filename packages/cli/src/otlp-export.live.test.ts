// The observability promise end to end (plan 101 slice 20, "done when"): one request through an
// action that queries a real Postgres reaches an OTLP collector as an HTTP SERVER span with the
// statement's CLIENT span under it — same trace, stable semconv names, legacy names gone — with
// nothing but the production telemetry boot (`startOtlpExport`) installed. No `x dev`, no
// statement observer: the DB span exists because the funnel opens it, in production.
// Needs `TEST_DATABASE_URL` (the test services' Postgres); unset, it skips, named.

import { afterAll, describe, expect, test } from 'bun:test';
import { action, toRoute } from '@ultimat3/action';
import { drain, resetLifecycle, resetTelemetry } from '@ultimat3/core';
import { type PostgresClient, postgresClient, setDbClient, sql } from '@ultimat3/db';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { allowHost } from '@ultimat3/testing';
import { startOtlpExport } from './otlp-export';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: string;
}
interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly attributes: readonly { readonly key: string; readonly value: OtlpValue }[];
}

/** OTLP's `SpanKind`: what the collector stores, not the framework's spelling of it. */
const SERVER = 2;
const CLIENT = 3;

/** Every span in every `/v1/traces` body the collector received. Parsed as the wire carries it. */
function spansOf(bodies: readonly string[]): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  for (const body of bodies) {
    const parsed = JSON.parse(body) as {
      resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
    };
    for (const resource of parsed.resourceSpans) {
      for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    }
  }
  return spans;
}

const attribute = (span: OtlpSpan | undefined, key: string): string | undefined => {
  const value = span?.attributes.find((entry) => entry.key === key)?.value;
  return value?.stringValue ?? value?.intValue;
};

/** The chain of parents from `span` up, inside the recorded set — a child at any depth. */
function ancestors(span: OtlpSpan, all: readonly OtlpSpan[]): readonly OtlpSpan[] {
  const chain: OtlpSpan[] = [];
  let parent = all.find((candidate) => candidate.spanId === span.parentSpanId);
  while (parent !== undefined) {
    chain.push(parent);
    const above = parent.parentSpanId;
    parent = all.find((candidate) => candidate.spanId === above);
  }
  return chain;
}

let client: PostgresClient | undefined;

// File scope, never inside the skipped suite: Bun evaluates a skipped file's body, and a reset
// that only the suite reaches leaves telemetry and lifecycle state behind for the next file.
afterAll(async () => {
  setDbClient(undefined);
  await client?.close();
  resetTelemetry();
  resetLifecycle();
});

describe.skipIf(!hasPostgres)('live · OTLP · request → action → Postgres', () => {
  test('the collector receives a server span with the statement span under it', async () => {
    const received: string[] = [];
    const collector = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/v1/traces') received.push(await request.text());
        return new Response('{}', { status: 200 });
      },
    });
    // The sealed test network admits the collector fixture and nothing else.
    allowHost(`127.0.0.1:${String(collector.port)}`);
    resetLifecycle();
    const release = startOtlpExport({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${String(collector.port)}/v1/traces`,
    });
    try {
      client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
      setDbClient(client);
      const reader = client;
      const probe = action({
        input: t.object({}),
        output: t.object({ one: t.number }),
        policy: allow(),
        handle: async () => {
          const rows = await reader.query<{ one: number }>(sql`select 1::int as one`);
          return { one: rows[0]?.one ?? 0 };
        },
      }).named('otlpProof');
      const route = toRoute(probe);
      const server = httpServer({
        routes: [route],
        config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      });

      const response = await server.fetch(
        new Request(`http://app.test${route.path}`, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(response.status).toBe(200);
      // The drain flushes the exporter: `close` phase, registered by the boot.
      await drain('SIGTERM');

      const spans = spansOf(received);
      const statement = spans.find(
        (span) => span.kind === CLIENT && attribute(span, 'db.query.text')?.includes('select 1'),
      );
      expect(statement?.name).toBe('db.select');
      expect(attribute(statement, 'db.system.name')).toBe('postgresql');
      expect(attribute(statement, 'db.operation.name')).toBe('SELECT');

      const request = spans.find((span) => span.kind === SERVER);
      expect(request?.name).toBe(`${route.method} ${route.path}`);
      expect(attribute(request, 'http.request.method')).toBe(route.method);
      expect(attribute(request, 'http.response.status_code')).toBe('200');
      expect(attribute(request, 'http.route')).toBe(route.path);

      // One trace, and the statement is the request's descendant (through `action.<name>`).
      if (statement === undefined || request === undefined) return;
      expect(statement.traceId).toBe(request.traceId);
      expect(ancestors(statement, spans).map((span) => span.spanId)).toContain(request.spanId);

      // The legacy spellings are gone from the wire, not merely joined by the new ones.
      const keys = new Set(spans.flatMap((span) => span.attributes.map((entry) => entry.key)));
      for (const legacy of ['http.method', 'http.status_code', 'http.target', 'db.statement']) {
        expect(keys.has(legacy)).toBe(false);
      }
    } finally {
      release();
      await collector.stop(true);
    }
  }, 30_000);
});
