// RUNS the billing recipe on `wiki/Building-Your-Own-Base.md`: a signed provider event, through the
// real http pipeline and the receiver's job, moves an org's plan — and the entitlement flag follows
// it. A bad signature, a body that is not JSON and an amount that is not the plan's price move
// nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Actor, hmac, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter, type Pipeline } from '@ultimat3/http';
import type { WebhookReceiver } from '@ultimat3/jobs';
import { testJobs } from '@ultimat3/testing';
import { exportsOf, type LoadedRecipe, loadRecipe } from '../lib/base-recipes';
import { repoRoot } from '../lib/run';

const SECRET = 'whsec_billing_recipe_proof';

interface PlanStore {
  setPlan(orgId: string, plan: string, eventId: string): Promise<void>;
}

/** What the proof reads off the fence — the names a reader would import. */
interface BillingRecipe {
  entitlement(name: string, description: string, plans: readonly string[]): unknown;
  entitled(name: string, actor: Actor | null, plan: string): boolean;
  billingReceiver(init: { secret: () => string; plans: () => PlanStore }): WebhookReceiver;
}

const plans = new Map<string, string>();
const writes: string[] = [];
const store: PlanStore = {
  setPlan(orgId, plan, eventId) {
    plans.set(orgId, plan);
    writes.push(eventId);
    return Promise.resolve();
  },
};

let loaded: LoadedRecipe;
let recipe: BillingRecipe;
let pipeline: Pipeline;

beforeAll(async () => {
  loaded = await loadRecipe(repoRoot(), 'apps/web/shared/base/billing.ts');
  recipe = exportsOf<BillingRecipe>(loaded, ['entitlement', 'entitled', 'billingReceiver']);
  recipe.entitlement('exports', 'CSV and PDF exports', ['team', 'scale']);
  const receiver = recipe.billingReceiver({ secret: () => SECRET, plans: () => store });
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
  pipeline = httpPipeline({ table: httpRouter(receiver.routes()), config });
});

afterAll(async () => {
  await loaded.dispose();
});

const post = (body: string, signature = hmac('sha256', SECRET, body, 'hex')) =>
  pipeline.handle(
    new Request('http://localhost/hooks/billing', {
      method: 'POST',
      headers: { 'x-billing-signature': signature, 'content-type': 'application/json' },
      body,
    }),
    { role: 'web' },
  );

const event = (id: string, orgId: string, plan: string, minor: number) =>
  JSON.stringify({
    id,
    type: 'plan.changed',
    orgId,
    plan,
    amount: { minor, currency: 'USD' },
  });

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { code?: unknown }).code;

describe('recipe · billing', () => {
  test('a signed plan change moves the org, and the entitlement follows the plan', async () => {
    const ana = userActor({ id: 'ana', orgId: 'org_1' });
    expect(recipe.entitled('exports', ana, plans.get('org_1') ?? 'free')).toBe(false);
    await using jobs = await testJobs();
    const response = await post(event('evt_1', 'org_1', 'team', 4_900));
    expect(response.status).toBe(200);
    const trace = await jobs.drain();
    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
    expect(plans.get('org_1')).toBe('team');
    expect(recipe.entitled('exports', ana, plans.get('org_1') ?? 'free')).toBe(true);
  });

  test('a bad signature is a 401 and queues nothing', async () => {
    await using jobs = await testJobs();
    const response = await post(event('evt_2', 'org_2', 'scale', 19_900), '00'.repeat(32));
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(await jobs.depth()).toBe(0);
    expect(plans.has('org_2')).toBe(false);
  });

  test('a signed body that is not JSON is the recipe’s own 422', async () => {
    await using jobs = await testJobs();
    const response = await post('{not json');
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('X_BILLING_EVENT_MALFORMED');
    expect(await jobs.depth()).toBe(0);
  });

  test('an amount that is not the plan price fails the job and moves nothing', async () => {
    await using jobs = await testJobs();
    expect((await post(event('evt_3', 'org_3', 'scale', 100))).status).toBe(200);
    const trace = await jobs.drain();
    expect(trace.executions.at(-1)?.code).toBe('X_BILLING_AMOUNT_MISMATCH');
    expect(plans.has('org_3')).toBe(false);
    expect(writes).not.toContain('evt_3');
  });
});
