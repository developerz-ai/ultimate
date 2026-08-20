// The read span has to cover the whole read. Wrapping `source.execute()` alone left the input
// parse, the policy evaluation and `sql()`'s construction outside every span, so a read whose
// cost was in building the source reported milliseconds under a parent that reported seconds.

import { describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  configureTelemetry,
  createContext,
  currentSpan,
  memoryExporter,
  resetTelemetry,
  userActor,
} from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { from } from './source';

interface Order {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const orders: readonly Order[] = [
  { id: 'a', orgId: ORG },
  { id: 'b', orgId: ORG },
];
const readerActor: Actor = { ...userActor({ id: 'u1' }), permissions: ['order:read'] };
const reader = createContext({ actor: readerActor });

/**
 * Records which span was ACTIVE while the policy ran and while `sql()` built the source — the two
 * stages the old span excluded. Structural rather than timed: the test clock is frozen, and
 * "was this work inside the span" is the claim anyway, not "did it take long".
 */
// `string | undefined` per field, not `string?`: `currentSpan()` answers `undefined` when NO span
// is active, and "the stage ran outside every span" is the exact regression this file pins — it
// has to be recordable, not unassignable.
interface ActiveSpans {
  policy?: string | undefined;
  sql?: string | undefined;
}

const listOrders = (inside: ActiveSpans, cached: boolean) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('order:read', () => {
      inside.policy = currentSpan()?.name;
      return true;
    }),
    ...(cached ? { cache: { tags: [{ entity: 'orders' }] } } : {}),
    live: true,
    sql: ({ orgId }) => {
      inside.sql = currentSpan()?.name;
      return from<Order>('orders', orders).where({ orgId });
    },
  }).named('listOrders');

async function traced(run: () => Promise<unknown>): Promise<readonly ReadableSpan[]> {
  const exporter = memoryExporter();
  configureTelemetry({ exporter });
  try {
    await run().catch(() => undefined);
    return exporter.spans;
  } finally {
    resetTelemetry();
  }
}

describe('the query span covers the whole read', () => {
  test('the policy and `sql()` both run INSIDE the span, not in a gap beside it', async () => {
    const inside: { policy?: string; sql?: string } = {};
    const spans = await traced(() => listOrders(inside, false)({ orgId: ORG }, { ctx: reader }));
    expect(spans.map((span) => span.name)).toEqual(['query.listOrders']);
    // Both were outside every span before: the read's cost could sit entirely in an unnamed gap.
    expect(inside.policy).toBe('query.listOrders');
    expect(inside.sql).toBe('query.listOrders');
  });

  test('the attributes say who, where, and how many rows came back', async () => {
    const spans = await traced(() =>
      listOrders({}, true)({ orgId: ORG }, { ctx: reader, surface: 'http' }),
    );
    const attributes = spans[0]?.attributes ?? {};
    expect(attributes['ultimate.primitive']).toBe('query');
    expect(attributes['ultimate.query']).toBe('listOrders');
    expect(attributes['ultimate.surface']).toBe('http');
    expect(attributes['ultimate.actor.kind']).toBe('user');
    expect(attributes['ultimate.live']).toBe(true);
    expect(attributes['ultimate.cached']).toBe(true);
    expect(attributes['ultimate.fresh']).toBe(false);
    expect(attributes['ultimate.rows']).toBe(2);
  });

  test('an uncached read says so, which is the first thing to ask of a slow one', async () => {
    const spans = await traced(() => listOrders({}, false)({ orgId: ORG }, { ctx: reader }));
    expect(spans[0]?.attributes['ultimate.cached']).toBe(false);
  });

  test('a denied read is still one span, and it records the refusal', async () => {
    const noGrants: Actor = { ...userActor({ id: 'u2' }), permissions: [] };
    const stranger = createContext({ actor: noGrants });
    const spans = await traced(() => listOrders({}, false)({ orgId: ORG }, { ctx: stranger }));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe('error');
  });
});
