// `onAudit`: the gate's decisions, as data, handed on AFTER `audit.ts` has written the log line —
// one audit path with a second destination, never a second path. Core's `AuditSink` records what
// an action or query DID (`surface: 'mcp'`); this records what the MCP gate decided, mostly before
// any primitive ran: hidden, scope-denied, invalid-args, a refused token. No `AuditRecord` can
// carry those — there is no `ctx`, often no primitive, and nothing ran.

import type { Clock, Logger } from '@ultimat3/core';
import { logger, stringField, systemClock } from '@ultimat3/core';
import type { RequestFacts as McpRequestFacts } from '@ultimat3/http';
import type { McpAuditEntry, McpResourceAuditEntry } from './audit';
import { auditResourceRead, auditToolCall } from './audit';

/** Why the transport refused before a caller existed. The 429 is `throttled` whichever came first. */
export type McpAuthRefusal = 'missing-token' | 'rejected-token' | 'not-an-agent' | 'throttled';

/** One decision. `at` is the auditor's clock, never `new Date()`; the token never travels. */
export type McpAuditEvent =
  | ({ readonly kind: 'tool-call'; readonly at: Date } & McpAuditEntry)
  | ({ readonly kind: 'resource-read'; readonly at: Date } & McpResourceAuditEntry)
  | {
      readonly kind: 'auth-refused';
      readonly at: Date;
      readonly reason: McpAuthRefusal;
      /** The HTTP status the caller was answered: 401, 403 or 429. */
      readonly status: number;
      readonly facts: McpRequestFacts;
    };

/**
 * Where the app keeps them: a table, a SIEM, a queue. Fire-and-forget by design — see `deliver`.
 * `createMcpServer({ onAudit })` and `defineAppMcp({ onAudit })`; the route reads its server's.
 */
export type McpAuditHook = (event: McpAuditEvent) => void | Promise<void>;

export interface McpAuditor {
  toolCall(entry: McpAuditEntry): void;
  resourceRead(entry: McpResourceAuditEntry): void;
  authRefused(reason: McpAuthRefusal, status: number, facts: McpRequestFacts): void;
}

export interface McpAuditorInput {
  readonly onAudit?: McpAuditHook | undefined;
  /** Stamps `at`. Defaulted, never read inline, so a test can freeze it. */
  readonly clock?: Clock | undefined;
  /** Where the lines go. The process logger unless a test reads them. */
  readonly log?: Logger | undefined;
}

export function mcpAuditor(input: McpAuditorInput = {}): McpAuditor {
  const log = input.log ?? logger;
  const clock = input.clock ?? systemClock;
  const hook = input.onAudit;
  return {
    toolCall(entry) {
      auditToolCall(entry, log);
      if (hook !== undefined) deliver(hook, { kind: 'tool-call', at: clock.now(), ...entry }, log);
    },
    resourceRead(entry) {
      auditResourceRead(entry, log);
      if (hook !== undefined) {
        deliver(hook, { kind: 'resource-read', at: clock.now(), ...entry }, log);
      }
    },
    authRefused(reason, status, facts) {
      // `warn`, the level of every refusal a prober can drive: a token walk is the same shape as a
      // tool-name walk one step earlier. The address and path carry the decision; the user agent
      // and origin stay in the event only — caller-controlled text an alert rule has no use for.
      log.warn(`mcp.auth.${reason}`, {
        surface: 'mcp',
        reason,
        status,
        path: facts.path,
        ...(facts.address === null ? {} : { address: facts.address }),
      });
      if (hook !== undefined) {
        deliver(hook, { kind: 'auth-refused', at: clock.now(), reason, status, facts }, log);
      }
    },
  };
}

/** The auditor a server built without `onAudit` uses: the log line, and nothing else. */
export const LOG_ONLY_AUDITOR: McpAuditor = mcpAuditor();

/**
 * A hook that throws or rejects changes NO answer. The log line — the record that cannot be turned
 * off — is already written, and a refusal that turned into a 500 when the app's sink was down
 * would be a signal a prober could read. So the failure is reported, once, at `error`, carrying the
 * thrown value's `code` when it has one and never its message: a sink's message names a host.
 * Not awaited, so a slow sink cannot hold a JSON-RPC answer; a hook that must not lose an event
 * queues it itself.
 */
function deliver(hook: McpAuditHook, event: McpAuditEvent, log: Logger): void {
  const failed = (thrown: unknown): void => {
    const code = stringField(thrown, 'code');
    log.error('mcp.audit-hook.failed', {
      surface: 'mcp',
      event: event.kind,
      ...(code === undefined ? {} : { code }),
    });
  };
  try {
    const pending = hook(event);
    if (pending instanceof Promise) pending.catch(failed);
  } catch (thrown) {
    failed(thrown);
  }
}
