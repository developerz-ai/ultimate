// The queued half of a batch: ONE framework job, `admin.batch`, that runs one chunk of a batch
// past its declared threshold through the same per-row gate an inline batch uses. A job and not a
// ninth kind of thing — `enqueue` and a declaration are all it uses of `@ultimat3/jobs`.

import { ACTOR_KINDS, type ActorKind, type ActorOrigin, withChildContext } from '@ultimat3/core';
import { type AnyJobHandle, getJob, job, t } from '@ultimat3/jobs';
import { coreActorOf } from './actor';
import type { AdminActor } from './authz';
import { type BatchEnqueue, type BatchRow, runBatchRows } from './batch';
import { AdminMountMissingError } from './errors';
import { jsonText } from './json-text';
import { adminMountAt, adminMounts } from './mounts';

/** The queued input text, back to an object. Anything else is no input, which the schema judges. */
const inputOf = (text: string): Readonly<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
};

/** The job's durable name: the queue key every queued chunk carries. Never renamed. */
export const ADMIN_BATCH_JOB = 'admin.batch';

/** Who can queue a chunk: anonymous never reaches the batch gate. */
const QUEUED_KINDS = ['user', 'service', 'agent'] as const satisfies readonly ActorKind[];

const chunkInput = t.object({
  basePath: t.string,
  entity: t.string,
  action: t.string,
  ids: t.array(t.string),
  // The action's input as JSON text: the action's own schema judges it again on the worker, so
  // the queue carries no second description of a contract this package does not own.
  input: t.string,
  batchId: t.string,
  index: t.number.int(),
  requestId: t.string,
  // Kind, scopes and `onBehalfOf` too: a chunk an agent queued was re-run as a user, so a rule
  // refusing agents passed every queued row it refused inline. Absent kind (a chunk queued before
  // the field existed) is a user, which is what it ran as then.
  actor: t.object({
    id: t.string,
    kind: t.optional(t.enum(QUEUED_KINDS)),
    roles: t.array(t.string),
    scopes: t.optional(t.array(t.string)),
    onBehalfOf: t.optional(t.object({ actorId: t.string, actorKind: t.enum(ACTOR_KINDS) })),
    permissions: t.optional(t.array(t.string)),
    orgId: t.optional(t.string),
    locale: t.optional(t.string),
    timeZone: t.optional(t.string),
  }),
});

export interface AdminBatchChunk {
  readonly basePath: string;
  readonly entity: string;
  readonly action: string;
  readonly ids: readonly string[];
  /** `jsonText` of the validated input. */
  readonly input: string;
  readonly batchId: string;
  readonly index: number;
  readonly requestId: string;
  readonly actor: {
    readonly id: string;
    readonly kind?: (typeof QUEUED_KINDS)[number] | undefined;
    readonly roles: readonly string[];
    readonly scopes?: readonly string[] | undefined;
    readonly onBehalfOf?: ActorOrigin | undefined;
    /** Direct grants: an operator who holds the permission with no role runs the batch too. */
    readonly permissions?: readonly string[] | undefined;
    readonly orgId?: string | undefined;
    readonly locale?: string | undefined;
    readonly timeZone?: string | undefined;
  };
}

/**
 * Run one chunk: find the admin it was queued from, and every row through the gate AS the
 * operator who queued it — their roles decide, their tenant scopes every read. Nothing about the
 * operator is trusted beyond what the queue row carries, which only the server wrote.
 */
export async function runBatchChunk(chunk: AdminBatchChunk): Promise<readonly BatchRow[]> {
  const app = adminMountAt(chunk.basePath);
  if (app === undefined) {
    throw new AdminMountMissingError({
      basePath: chunk.basePath,
      mounted: adminMounts().map((one) => one.basePath),
    });
  }
  const resource = app.resource(chunk.entity);
  const action = resource.actions.find((declared) => declared.name === chunk.action);
  // An action renamed or removed between the enqueue and the claim has nothing to run: every row
  // is refused by the gate's own answer for an action this resource does not declare.
  if (action === undefined) {
    return chunk.ids.map((id) => ({ id, outcome: 'refused', reason: 'admin.actions.unknown' }));
  }
  const actor: AdminActor = {
    id: chunk.actor.id,
    ...(chunk.actor.kind === undefined ? {} : { kind: chunk.actor.kind }),
    roles: chunk.actor.roles,
    ...(chunk.actor.scopes === undefined ? {} : { scopes: chunk.actor.scopes }),
    ...(chunk.actor.onBehalfOf === undefined ? {} : { onBehalfOf: chunk.actor.onBehalfOf }),
    ...(chunk.actor.permissions === undefined ? {} : { permissions: chunk.actor.permissions }),
    ...(chunk.actor.orgId === undefined ? {} : { orgId: chunk.actor.orgId }),
    ...(chunk.actor.locale === undefined ? {} : { locale: chunk.actor.locale }),
    ...(chunk.actor.timeZone === undefined ? {} : { timeZone: chunk.actor.timeZone }),
  };
  const ctx = app.ctx({ actor, requestId: chunk.requestId });
  // The operator is the ambient actor too, of their real kind, tenant included — what the
  // entity's tenant guard reads — exactly as `mcp.ts` installs an agent for its call.
  return withChildContext({ actor: coreActorOf(actor) }, () =>
    runBatchRows({ resource, action, ctx, ids: chunk.ids, input: inputOf(chunk.input) }),
  );
}

/**
 * The job, declared on first use and once per process. `tenant: 'none'` because the TENANT is
 * the operator's and the body installs it (`runBatchChunk`); a chunk is one attempt — a handler
 * that half-ran is not one to re-run, and every row it reached is already on the audit log.
 */
export function adminBatchJob(): AnyJobHandle {
  const seated = getJob(ADMIN_BATCH_JOB);
  if (seated !== undefined) return seated;
  return job({
    name: ADMIN_BATCH_JOB,
    input: chunkInput,
    idempotencyKey: (chunk) => `${ADMIN_BATCH_JOB}:${chunk.batchId}:${String(chunk.index)}`,
    tenant: 'none',
    retry: { attempts: 1, backoff: 'fixed' },
    // A chunk's input is the server's own, written by `batchEnqueue` below: parsed, never trusted
    // past what it names — the rows are decided again, one by one, on the worker.
    run: ({ input }) => runBatchChunk(input),
  }) as AnyJobHandle;
}

/** The kind a chunk carries; anonymous cannot have queued one, so it carries none. */
const queuedKind = (kind: ActorKind | undefined): (typeof QUEUED_KINDS)[number] | undefined =>
  kind === 'anonymous' ? undefined : kind;

/** What `runAdminBatch` queues a chunk with: one `admin.batch` job, its id answered. */
export const batchEnqueue =
  (basePath: string): BatchEnqueue =>
  async (chunk) => {
    const actor = chunk.ctx.actor;
    const queued = await adminBatchJob().enqueue({
      basePath,
      entity: chunk.resource.name,
      action: chunk.action.name,
      ids: [...chunk.ids],
      input: jsonText(chunk.input),
      batchId: chunk.batchId,
      index: chunk.index,
      requestId: chunk.ctx.requestId,
      actor: {
        id: actor.id,
        ...(queuedKind(actor.kind) === undefined ? {} : { kind: queuedKind(actor.kind) }),
        roles: [...(actor.roles ?? [])],
        ...(actor.scopes === undefined ? {} : { scopes: [...actor.scopes] }),
        ...(actor.onBehalfOf === undefined ? {} : { onBehalfOf: { ...actor.onBehalfOf } }),
        ...(actor.permissions === undefined ? {} : { permissions: [...actor.permissions] }),
        ...(actor.orgId === undefined ? {} : { orgId: actor.orgId }),
        ...(actor.locale === undefined ? {} : { locale: actor.locale }),
        ...(actor.timeZone === undefined ? {} : { timeZone: actor.timeZone }),
      },
    } satisfies AdminBatchChunk);
    return queued.id;
  };
