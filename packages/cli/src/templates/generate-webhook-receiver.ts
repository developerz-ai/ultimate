// `x g webhook-receiver` — one inbound webhook: `webhookReceiver()`, a factory over `job()` plus the
// route that feeds it. The route reads the exact bytes, `verify` checks the hmac and reads the event
// OUT OF THE SIGNED BYTES, the event is queued durably and only then acknowledged. Which vendor and
// what an event means stay the app's: the template is a timestamped hmac, refused outside a window.

import type { ExerciseEntry } from '../exercise-entry-edit';
import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

/** `billing-events` → `BILLING_EVENTS`: the prefix of the path, header and secret constants. */
const constant = (name: NameSet): string => name.kebab.replaceAll('-', '_').toUpperCase();

const source = (name: NameSet, path: string): string => {
  const c = constant(name);
  return `// ${name.camel}: one inbound webhook. \`webhookReceiver()\` is a factory over job(): the route reads the
// exact bytes, \`verify\` checks the hmac over \`<timestamp>.<body>\`, refuses a delivery signed
// outside the replay window and reads the event out of the SIGNED bytes — so one captured request
// is neither replayable later nor under fresh ids — and the event is queued durably before it is
// acknowledged. List this module in apps/web/api/index.ts's \`jobs:\`: the boot mounts it.

import { ambientClock } from '@ultimat3/core';
import { defineError } from '@ultimat3/core/page';
import { verifyBodyHmac } from '@ultimat3/http';
import { t, webhookReceiver } from '@ultimat3/jobs';

/**
 * Where the vendor sends events, and the two headers it signs with. ASSUMED, so check your
 * vendor's docs: the mac is hex HMAC-SHA256 over \`<unix seconds>.<raw body>\` (Stripe's \`v1\`
 * canonical form) behind \`sha256=\`, the seconds in their own header. A vendor that signs another
 * shape changes \`signedBytes\` and these names — never drops the timestamp: without it a
 * captured delivery verifies forever.
 */
export const ${c}_PATH = '/hooks/${name.kebab}';
export const ${c}_SIGNATURE_HEADER = 'x-signature';
export const ${c}_TIMESTAMP_HEADER = 'x-signature-timestamp';
/** The replay bound, both ways: five minutes is the window senders in the wild already assume. */
export const ${c}_TOLERANCE_MS = 300_000;

/** The part of the vendor's payload this app reads. The app's schema, never the framework's. */
const ${name.pascal}Event = t.object({ id: t.string, type: t.string });

/** The body verified and is not the event: the vendor sent it, so a retry sends it again. */
export const ${name.pascal}Unreadable = defineError<string>({
  code: 'X_${c}_UNREADABLE',
  title: 'a verified ${name.kebab} event is not the shape this app reads',
  status: 400,
  cause: (reason) => \`the ${name.kebab} event verified and \${reason}\`,
  fix: 'x jobs list --name ${name.kebab} --json — then compare the vendor payload with ${name.pascal}Event in ${path}',
});

/**
 * Authentic and old: a replay, or a sender clock far off. Checked AFTER the mac, so this code
 * means "signed by the vendor" and never "unreadable": the queue dedupes only while a job is live.
 */
export const ${name.pascal}Stale = defineError<string>({
  code: 'X_${c}_STALE',
  title: 'a signed ${name.kebab} delivery is outside the replay window',
  status: 401,
  cause: (reason) => \`the ${name.kebab} delivery is signed and \${reason}\`,
  fix: 'const ${c}_TOLERANCE_MS = 600_000;   // in ${path}, only if the vendor queues deliveries longer than five minutes — an older one is a replay and stays refused',
});

/**
 * Comma-separated, so a rotation keeps the old secret live beside the new one. Unset is \`['']\`,
 * which \`verifyBodyHmac\` refuses as X_CONFIG_INVALID — never a mac under an empty key.
 */
const SECRET_ENV = '${c}_WEBHOOK_SECRET';
const secrets = (): readonly string[] => (Bun.env[SECRET_ENV] ?? '').split(',');

/** \`<stamp>.\` then the body, as bytes: the body is never decoded before the mac is taken. */
function signedBytes(stamp: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(\`\${stamp}.\`);
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
}

/** The signed seconds against this clock. A stamp that is not seconds is no window at all. */
function assertFresh(stamp: string): void {
  if (!/^\\d{1,12}$/.test(stamp)) {
    throw new ${name.pascal}Stale('carries no unix-seconds timestamp');
  }
  const skewMs = Math.abs(ambientClock().now().getTime() - Number(stamp) * 1_000);
  if (skewMs > ${c}_TOLERANCE_MS) {
    const reason = \`was signed \${skewMs}ms from this clock, beyond \${${c}_TOLERANCE_MS}ms\`;
    throw new ${name.pascal}Stale(reason);
  }
}

/**
 * The verified text as the event. \`JSON.parse\`'s own message quotes the token it stopped at,
 * which is a piece of the body, so it is replaced whole by a code that names none of it.
 */
function readEvent(text: string | null) {
  let value: unknown;
  try {
    value = JSON.parse(text ?? '');
  } catch {
    throw new ${name.pascal}Unreadable('is not JSON');
  }
  try {
    return ${name.pascal}Event.parse(value, '${name.kebab} event');
  } catch {
    throw new ${name.pascal}Unreadable('does not carry a string id and type');
  }
}

export const ${name.camel} = webhookReceiver({
  // Pinned: the queue keys its rows by this name, and the route is \`webhook.${name.kebab}\`.
  name: '${name.kebab}',
  path: ${c}_PATH,
  // The vendor's account is the app's, not an org's. A per-org receiver reads the org out of the
  // verified event instead: \`tenant: (event) => event.orgId\`.
  tenant: 'none',
  verify: (inbound) => {
    const stamp = inbound.headers.get(${c}_TIMESTAMP_HEADER) ?? '';
    const { text } = verifyBodyHmac({
      bytes: signedBytes(stamp, inbound.bytes),
      secret: secrets(),
      given: inbound.headers.get(${c}_SIGNATURE_HEADER),
      encoding: 'hex',
      prefix: 'sha256=',
    });
    assertFresh(stamp);
    const event = readEvent(text === null ? null : text.slice(stamp.length + 1));
    return { eventId: event.id, topic: event.type, payload: event };
  },
  // At least once per event id: a redelivery inside the window after this settles runs again, so a
  // write here is an upsert keyed by \`eventId\`, never an insert.
  handle: async ({ eventId, payload }) => ({ eventId, type: payload.type }),
  retry: { attempts: 5, backoff: 'exponential' },
});
`;
};

const unitSuite = (name: NameSet): string => {
  const c = constant(name);
  return `// ${name.camel}, unit: the vendor's bytes through the real pipeline on the in-memory queue. What
// is worth failing on is this app's half — the secret, the replay window, the event read out of
// the SIGNED body and the code that replaces a parser message — never the framework's route.

import { ambientClock, hmac } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import {
  ${c}_PATH,
  ${c}_SIGNATURE_HEADER,
  ${c}_TIMESTAMP_HEADER,
  ${c}_TOLERANCE_MS,
  ${name.camel},
} from './${name.kebab}';

const SECRET = 'whsec_${name.snake}_unit';
const SECRET_ENV = '${c}_WEBHOOK_SECRET';

/** The secret this run verifies under, put back after: the environment is process-global. */
const withSecret = async (secret: string, run: () => Promise<void>): Promise<void> => {
  const before = Bun.env[SECRET_ENV];
  Bun.env[SECRET_ENV] = secret;
  try {
    await run();
  } finally {
    if (before === undefined) delete Bun.env[SECRET_ENV];
    else Bun.env[SECRET_ENV] = before;
  }
};

/** Unix seconds on the clock the receiver reads, \`agoMs\` in the past. */
const stampAgo = (agoMs = 0): string =>
  String(Math.floor((ambientClock().now().getTime() - agoMs) / 1_000));

/** What the vendor sends: a mac over \`<timestamp>.<body>\`, so the time is signed too. */
const sign = (body: string, stamp: string, secret = SECRET): string =>
  \`sha256=\${hmac('sha256', secret, \`\${stamp}.\${body}\`, 'hex')}\`;

const deliver = (body: string, signature: string, stamp: string): Promise<Response> =>
  httpPipeline({
    table: httpRouter(${name.camel}.routes()),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  }).handle(
    new Request(\`http://localhost\${${c}_PATH}\`, {
      method: 'POST',
      headers: {
        [${c}_SIGNATURE_HEADER]: signature,
        [${c}_TIMESTAMP_HEADER]: stamp,
      },
      body,
    }),
    { role: 'web' },
  );

unitTest('a signed event is queued, then handled from its verified payload', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_unit","type":"thing.happened"}';
    const stamp = stampAgo();
    const response = await deliver(body, sign(body, stamp), stamp);
    expect(await response.json()).toEqual({ ok: true, eventId: 'evt_unit', deduped: false });
    const trace = await runJobs.drain();
    expect(trace.executions.map((run) => [run.outcome, run.result])).toEqual([
      ['completed', { eventId: 'evt_unit', type: 'thing.happened' }],
    ]);
  }),
);

unitTest('a body signed under another secret is refused, and nothing is queued', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_forged","type":"thing.happened"}';
    const stamp = stampAgo();
    const response = await deliver(body, sign(body, stamp, 'whsec_someone_else'), stamp);
    expect((await response.json()).code).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(await runJobs.depth(${name.camel})).toBe(0);
  }),
);

unitTest('a delivery replayed after the window is refused, and nothing is queued', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_replayed","type":"thing.happened"}';
    const old = stampAgo(${c}_TOLERANCE_MS + 60_000);
    const replayed = await deliver(body, sign(body, old), old);
    expect(replayed.status).toBe(401);
    expect((await replayed.json()).code).toBe('X_${c}_STALE');
    // The same signature under a fresh timestamp: the time is inside the mac, so it is a forgery.
    const restamped = await deliver(body, sign(body, old), stampAgo());
    expect((await restamped.json()).code).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(await runJobs.depth(${name.camel})).toBe(0);
  }),
);

unitTest('a signed body that is not the event is refused with this app code', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_short"}';
    const stamp = stampAgo();
    const response = await deliver(body, sign(body, stamp), stamp);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('X_${c}_UNREADABLE');
    expect(await runJobs.depth(${name.camel})).toBe(0);
  }),
);
`;
};

/**
 * The job's entry in `apps/web/exercise.ts`. A draw cannot sign a vendor's event and `payload` is
 * free JSON the handler trusts as verified, so `x exercise` queues what the route would have.
 */
const exerciseEntry = (name: NameSet): ExerciseEntry => ({
  name: name.kebab,
  value: [
    '{',
    '  actor: null,',
    '  // What the verified route queues: the event read out of the signed body.',
    '  input: () => ({',
    "    eventId: 'evt_exercise',",
    "    topic: 'thing.happened',",
    "    payload: { id: 'evt_exercise', type: 'thing.happened' },",
    '  }),',
    '}',
  ].join('\n'),
});

/** The receiver and its unit test, in the feature's `jobs/`. */
export function webhookReceiverFiles(
  rawName: string,
  target: FeatureTarget,
): readonly GeneratedFile[] {
  const name = names(rawName);
  const path = `${target.surfaceDir}/${target.feature}/jobs/${name.kebab}.ts`;
  return [
    { path, contents: source(name, path), exercise: exerciseEntry(name) },
    { path: path.replace(/\.ts$/, '.test.ts'), contents: unitSuite(name) },
  ];
}
