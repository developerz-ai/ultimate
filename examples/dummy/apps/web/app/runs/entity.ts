/**
 * The runs feature's view schemas. The tables live in `@postly/db` because admin and the worker
 * need them too; what a connection and a run look like on the wire is this feature's business.
 *
 * `ConnectionView` names no `credential`: a `.sealed()` column in a view is
 * `X_ENTITY_SEALED_IN_VIEW`, so the secret cannot be listed here by accident.
 *
 * `t` comes from @ultimat3/schema here, not from a primitive package: this file declares no
 * primitive, so schema is its one import.
 */

import {
  CONNECTION_CREDENTIAL_MAX,
  CONNECTION_EXIT_MAX,
  CONNECTION_LABEL_MAX,
  connections,
} from '@postly/db';
import { type Infer, t } from '@ultimat3/schema';

/** How many connections the console lists. One page: a picker, not a browser. */
export const CONNECTION_PAGE = 50;

export const ConnectionView = connections.$view(['id', 'label', 'createdAt']);
export type ConnectionView = typeof ConnectionView.$row;

/** What a caller supplies to connect a site. `id`, `orgId` and `createdAt` are the server's. */
export const ConnectInput = t.object({
  orgId: t.uuid,
  label: t.string.min(1).max(CONNECTION_LABEL_MAX),
  credential: t.string.min(1).max(CONNECTION_CREDENTIAL_MAX),
  exit: t.optional(t.string.max(CONNECTION_EXIT_MAX)),
});
export type ConnectInput = Infer<typeof ConnectInput>;

/**
 * The handle `startRun` answers. Both ids are the queue's own: `runId` is what the run's events
 * and its prompts are keyed by, `jobId` is what `cancelRun` cancels.
 */
export const RunStarted = t.object({ runId: t.uuid, jobId: t.string });
export type RunStarted = Infer<typeof RunStarted>;

/** Shown once: the key's plaintext is not stored, so this answer is the only copy of it. */
export const RunKeyIssued = t.object({ id: t.string, prefix: t.string, key: t.string });
export type RunKeyIssued = Infer<typeof RunKeyIssued>;
