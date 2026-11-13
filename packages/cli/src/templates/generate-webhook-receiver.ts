// `x g webhook-receiver` — one inbound webhook: `webhookReceiver()`, a factory over `job()` plus the
// route that feeds it. The route reads the exact bytes, `verify` checks the hmac and reads the event
// OUT OF THE SIGNED BYTES, the event is queued durably and only then acknowledged. Which vendor and
// what an event means stay the app's: the template is an hmac over the body, the common shape.

import type { ExerciseEntry } from '../exercise-entry-edit';
import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

/** `billing-events` → `BILLING_EVENTS`: the prefix of the path, header and secret constants. */
const constant = (name: NameSet): string => name.kebab.replaceAll('-', '_').toUpperCase();

const source = (name: NameSet, path: string): string => {
  const c = constant(name);
  return `// ${name.camel}: one inbound webhook. \`webhookReceiver()\` is a factory over job(): the route reads the
// exact bytes, \`verify\` checks the hmac and reads the event out of the SIGNED bytes — its id
// included, so one captured signature cannot be replayed under fresh ids — and the event is queued
// durably before it is acknowledged. List this module in apps/web/api/index.ts's \`jobs:\`: the
// boot mounts the route of every receiver it was handed.

import { defineError } from '@ultimat3/core/page';
import { verifyBodyHmac } from '@ultimat3/http';
import { t, webhookReceiver } from '@ultimat3/jobs';

/** Where the vendor sends events, and the header its signature rides in. */
export const ${c}_PATH = '/hooks/${name.kebab}';
export const ${c}_SIGNATURE_HEADER = 'x-signature';

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
 * Comma-separated, so a rotation keeps the old secret live beside the new one. Unset is \`['']\`,
 * which \`verifyBodyHmac\` refuses as X_CONFIG_INVALID — never a mac under an empty key.
 */
const SECRET_ENV = '${c}_WEBHOOK_SECRET';
const secrets = (): readonly string[] => (Bun.env[SECRET_ENV] ?? '').split(',');

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
    const { text } = verifyBodyHmac({
      bytes: inbound.bytes,
      secret: secrets(),
      given: inbound.headers.get(${c}_SIGNATURE_HEADER),
      encoding: 'hex',
      prefix: 'sha256=',
    });
    const event = readEvent(text);
    return { eventId: event.id, topic: event.type, payload: event };
  },
  // At least once per event id: a redelivery after this settles runs again, so a write here is an
  // upsert keyed by \`eventId\`, never an insert.
  handle: async ({ eventId, payload }) => ({ eventId, type: payload.type }),
  retry: { attempts: 5, backoff: 'exponential' },
});
`;
};

const unitSuite = (name: NameSet): string => {
  const c = constant(name);
  return `// ${name.camel}, unit: the vendor's bytes through the real pipeline on the in-memory queue. What
// is worth failing on is this app's half — the secret, the event read out of the SIGNED body and
// the code that replaces a parser message — never the framework's route.

import { hmac } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import {
  ${c}_PATH,
  ${c}_SIGNATURE_HEADER,
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

const sign = (body: string, secret = SECRET): string =>
  \`sha256=\${hmac('sha256', secret, body, 'hex')}\`;

const deliver = (body: string, signature: string): Promise<Response> =>
  httpPipeline({
    table: httpRouter(${name.camel}.routes()),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  }).handle(
    new Request(\`http://localhost\${${c}_PATH}\`, {
      method: 'POST',
      headers: { [${c}_SIGNATURE_HEADER]: signature },
      body,
    }),
    { role: 'web' },
  );

unitTest('a signed event is queued, then handled from its verified payload', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_unit","type":"thing.happened"}';
    const response = await deliver(body, sign(body));
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
    const response = await deliver(body, sign(body, 'whsec_someone_else'));
    expect((await response.json()).code).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(await runJobs.depth(${name.camel})).toBe(0);
  }),
);

unitTest('a signed body that is not the event is refused with this app code', ({ runJobs }) =>
  withSecret(SECRET, async () => {
    const body = '{"id":"evt_short"}';
    const response = await deliver(body, sign(body));
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
