// `--shape saas`'s payment webhook: `x g webhook-receiver billing-events --feature billing`'s own
// output — the hmac, the replay window, the event read out of the signed bytes — called here, never
// re-spelled, then edited at anchors that must each occur once: the event names an org and a plan,
// the run acts as that org, and its body writes the org's subscription. A moved anchor fails here.

import type { ExerciseEntry } from '../../exercise-entry-edit';
import { webhookReceiverFiles } from '../generate-webhook-receiver';
import type { GeneratedFile } from '../naming';
import { applyEdit, type ShapeEdit } from './overlay';
import { BILLING_DIR } from './saas-billing';

export const RECEIVER_NAME = 'billing-events';
export const RECEIVER_PATH = `${BILLING_DIR}/jobs/${RECEIVER_NAME}.ts`;
const TEST_PATH = RECEIVER_PATH.replace(/\.ts$/, '.test.ts');

const sourceEdits: readonly Omit<ShapeEdit, 'path'>[] = [
  // The generator's comment names one vendor's canonical form; a shape names none (shapes.test.ts).
  { find: "(Stripe's `v1`\n * canonical form)", replace: '(a common\n * canonical form)' },
  {
    find: "import { t, webhookReceiver } from '@ultimat3/jobs';\n",
    replace:
      "import { t, webhookReceiver } from '@ultimat3/jobs';\nimport { PLAN_IDS } from '../plans';\nimport * as repo from '../repo';\n",
  },
  {
    find: "/** The part of the vendor's payload this app reads. The app's schema, never the framework's. */\nconst BillingEventsEvent = t.object({ id: t.string, type: t.string });",
    replace: [
      '/**',
      " * The part of the vendor's payload this app reads. The app's schema, never the framework's. It",
      ' * states the plan the org is now on — `free` once a subscription ends — never a delta, so an',
      ' * event delivered out of order still leaves a plan the provider sent.',
      ' */',
      'const BillingEventsEvent = t.object({',
      '  id: t.string,',
      '  type: t.string,',
      '  orgId: t.uuid,',
      '  plan: t.enum(PLAN_IDS),',
      '});',
    ].join('\n'),
  },
  {
    find: "'does not carry a string id and type'",
    replace: "'does not carry an id, a type, an org id and a known plan'",
  },
  {
    find: "  // The vendor's account is the app's, not an org's. A per-org receiver reads the org out of the\n  // verified event instead: `tenant: (event) => event.orgId`.\n  tenant: 'none',",
    replace:
      '  // Per org: the run acts as the org the SIGNED event names, so its write is that org’s and no other.\n  tenant: (event) => event.orgId,',
  },
  {
    find: 'return { eventId: event.id, topic: event.type, payload: event };',
    replace: 'return { eventId: event.id, orgId: event.orgId, topic: event.type, payload: event };',
  },
  {
    find: '  // At least once per event id: a redelivery inside the window after this settles runs again, so a\n  // write here is an upsert keyed by `eventId`, never an insert.\n  handle: async ({ eventId, payload }) => ({ eventId, type: payload.type }),',
    replace:
      "  // At least once per event id: the write is an upsert on the org's one row, so a redelivery\n  // writes the same plan again. The entitlements read it on the org's next call.\n  handle: async ({ eventId, orgId, payload, step }) => {\n    // The run's tenant — `verify` read it out of the signed event, so it IS `payload.orgId`.\n    const org = orgId ?? payload.orgId;\n    // A step, so a run resumed after a crash does not write the row a second time.\n    await step.run('apply-plan', () =>\n      repo.applyPlan({ orgId: org, plan: payload.plan, lastEventId: eventId }),\n    );\n    return { eventId, plan: payload.plan };\n  },",
  },
];

const testEdits: readonly Omit<ShapeEdit, 'path'>[] = [
  {
    find: "import { ambientClock, hmac } from '@ultimat3/core';",
    replace: "import { ambientClock, ctxOf, hmac, runWithContext } from '@ultimat3/core';",
  },
  {
    find: "import { expect, unitTest } from '@ultimat3/testing';\n",
    replace:
      "import { testActor } from '@ultimat3/policy';\nimport { expect, unitTest } from '@ultimat3/testing';\nimport { planOf } from '../entitlements';\n",
  },
  {
    find: "const SECRET_ENV = 'BILLING_EVENTS_WEBHOOK_SECRET';\n",
    replace: `const SECRET_ENV = 'BILLING_EVENTS_WEBHOOK_SECRET';
const ORG = '00000000-0000-4000-8000-0000000000b1';

/** The org's plan, read as one of its members reads it. */
const planOfOrg = (): Promise<string> =>
  runWithContext(ctxOf({ actor: testActor('member', { orgId: ORG }).actor }), planOf);
`,
  },
  {
    find: `const body = '{"id":"evt_unit","type":"thing.happened"}';`,
    replace: `const body = JSON.stringify({ id: 'evt_unit', type: 'plan.changed', orgId: ORG, plan: 'pro' });`,
  },
  {
    find: "      ['completed', { eventId: 'evt_unit', type: 'thing.happened' }],\n    ]);\n",
    replace:
      "      ['completed', { eventId: 'evt_unit', plan: 'pro' }],\n    ]);\n    // The entitlement moved: the org the signed event names is on the plan it names.\n    expect(await planOfOrg()).toBe('pro');\n",
  },
  {
    find: "unitTest('a signed event is queued, then handled from its verified payload', ({ runJobs }) =>\n  withSecret(SECRET, async () => {\n",
    replace:
      "unitTest('a signed event is queued, then moves the org to its plan', ({ runJobs }) =>\n  withSecret(SECRET, async () => {\n    expect(await planOfOrg()).toBe('free');\n",
  },
];

/** The org every scaffold's `apps/web/exercise.ts` acts in. */
const DEMO_ORG = '00000000-0000-4000-8000-000000000002';

/** What the verified route would queue: `x exercise` cannot sign an event. */
const exercise: ExerciseEntry = {
  name: RECEIVER_NAME,
  value: [
    '{',
    `  actor: userActor({ id: 'billing', orgId: '${DEMO_ORG}' }),`,
    "  // What the verified route queues. The top-level orgId is the run's tenant, bound per draw.",
    '  input: () => ({',
    "    eventId: 'evt_exercise',",
    `    orgId: '${DEMO_ORG}',`,
    "    topic: 'plan.changed',",
    '    payload: {',
    "      id: 'evt_exercise',",
    "      type: 'plan.changed',",
    `      orgId: '${DEMO_ORG}',`,
    "      plan: 'pro',",
    '    },',
    '  }),',
    '}',
  ].join('\n'),
};

const edited = (file: GeneratedFile, edits: readonly Omit<ShapeEdit, 'path'>[]): string =>
  edits.reduce(
    (text, edit) => applyEdit(text, { ...edit, path: file.path }),
    typeof file.contents === 'string' ? file.contents : '',
  );

/** The generator's two files, edited into the payment receiver this shape needs. */
export function billingReceiverFiles(): readonly GeneratedFile[] {
  const target = { surfaceDir: 'apps/web/app', feature: 'billing' };
  return webhookReceiverFiles(RECEIVER_NAME, target).map((file): GeneratedFile => {
    if (file.path === RECEIVER_PATH)
      return { path: file.path, contents: edited(file, sourceEdits), exercise };
    if (file.path === TEST_PATH) return { path: file.path, contents: edited(file, testEdits) };
    return file;
  });
}
