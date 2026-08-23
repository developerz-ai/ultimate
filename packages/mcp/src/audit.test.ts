// The audit line as the enumeration ALERT, not as bookkeeping. A hidden tool tells the prober
// nothing — `tools/list` omits it and the call answers ToolNotFound — so this log is the only
// place a name walk is ever visible, which is why `hidden` must reach it at `warn`.
// The severity table below IS that contract: demote one outcome to `debug` and the alert
// silently stops firing, with every other test in the package still green.

import { describe, expect, test } from 'bun:test';
import type { Logger } from '@ultimat3/core';
import { agentActor, createLogger, frozenClock } from '@ultimat3/core';
import type { McpOutcome } from './audit';
import { auditToolCall, outcomeForCode, outcomeForResult } from './audit';
import type { McpCaller, McpToolResult } from './registry';

interface Capture {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
}

function capture(): Capture {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'trace',
    clock: frozenClock('2026-08-09T00:00:00.000Z'),
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

const caller: McpCaller = {
  actor: agentActor({ id: 'agent-7' }),
  scopes: new Set(['orders:write']),
  role: 'member',
};

describe('audit levels', () => {
  const expected: Readonly<Record<McpOutcome, string>> = {
    ok: 'info',
    hidden: 'warn',
    'scope-denied': 'warn',
    'policy-denied': 'warn',
    'invalid-args': 'info',
    failed: 'error',
  };

  test('every refusal a prober can drive is warn, and only a bug is error', () => {
    const { logger, lines } = capture();
    for (const outcome of Object.keys(expected) as McpOutcome[]) {
      auditToolCall({ tool: 'orders.refund', outcome, caller }, logger);
    }
    expect(lines.map((line) => [line['outcome'], line['level']])).toEqual(Object.entries(expected));
  });

  test('the line names the subsystem, the event and the caller', () => {
    const { logger, lines } = capture();
    auditToolCall(
      { tool: 'orders.refund', outcome: 'scope-denied', caller, scope: 'orders:write' },
      logger,
    );
    expect(lines[0]).toMatchObject({
      msg: 'mcp.tool-call.scope-denied',
      surface: 'mcp',
      tool: 'orders.refund',
      outcome: 'scope-denied',
      actor: 'agent-7',
      actorKind: 'agent',
      role: 'member',
      scope: 'orders:write',
    });
  });

  test('optional fields are absent rather than null when they do not apply', () => {
    const { logger, lines } = capture();
    auditToolCall(
      { tool: 'org.profile', outcome: 'ok', caller: { actor: caller.actor, scopes: new Set() } },
      logger,
    );
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual([
      'actor',
      'actorKind',
      'level',
      'msg',
      'outcome',
      'surface',
      'tool',
      'ts',
    ]);
  });
});

describe('outcomeForCode', () => {
  test('authz codes are outcome 3, wherever in the stack they were decided', () => {
    expect(outcomeForCode('X_FORBIDDEN')).toBe('policy-denied');
    expect(outcomeForCode('X_UNAUTHENTICATED')).toBe('policy-denied');
    // The superseded name, pinned as NOT a denial: `X_POLICY_DENIED` was collapsed onto
    // `X_FORBIDDEN`, and a set that still recognised it would let the old code back in
    // classifying correctly — which is exactly how a twin survives a rename.
    expect(outcomeForCode('X_POLICY_DENIED')).toBe('failed');
  });

  test('anything else wants a human — including input the JSON Schema already passed', () => {
    // A projected action rejecting input MCP validated means the two schemas have drifted.
    expect(outcomeForCode('X_INPUT_INVALID')).toBe('failed');
    expect(outcomeForCode('X_MCP_QUERY_REJECTED')).toBe('failed');
  });
});

/**
 * A tool that renders its OWN refusal (`@ultimat3/admin` does, so the model reads a code/cause/fix
 * body rather than a transport failure) was audited as `policy-denied` at `warn` whatever it
 * refused for — so a malformed `admin.create` landed in the bucket this file calls "every refusal
 * a prober can drive", beside the denials an alert rule is watching for.
 */
/**
 * A real `McpToolResult`, which is what the transport hands the classifier. `outcomeForResult`'s
 * parameter is structural and narrower than the interface — it reads `isError` and `code` and
 * nothing else — so a fresh object literal carrying the `content` every actual result has is an
 * excess property against it. Driving the cases through the shipped shape keeps them the transport's.
 */
const rendered = (over: Omit<McpToolResult, 'content'> = {}): McpToolResult => ({
  content: [],
  ...over,
});

describe('outcomeForResult classifies a tool that rendered its own error', () => {
  test('a result that is not an error is outcome ok', () => {
    expect(outcomeForResult(rendered())).toBe('ok');
    expect(outcomeForResult(rendered({ isError: false }))).toBe('ok');
  });

  test('an isError result naming no code stays outcome 3, the conservative reading', () => {
    expect(outcomeForResult(rendered({ isError: true }))).toBe('policy-denied');
  });

  test('a named code is classified exactly as a THROWN one is — one classifier, not two', () => {
    expect(outcomeForResult(rendered({ isError: true, code: 'X_ADMIN_DENIED' }))).toBe(
      'policy-denied',
    );
    expect(outcomeForResult(rendered({ isError: true, code: 'X_ADMIN_INVALID' }))).toBe(
      'invalid-args',
    );
    expect(outcomeForResult(rendered({ isError: true, code: 'X_DB_UNREACHABLE' }))).toBe('failed');
  });

  test('the admin codes are classified where they are decided', () => {
    // `X_ADMIN_DENIED` is authz saying no, wherever it was decided — the same outcome
    // `X_FORBIDDEN` gets. `X_ADMIN_INVALID` is the caller mis-typing an argument the published
    // JSON Schema could not have refused: admin publishes a `type` per field and nothing else,
    // so the entity's own rules are the first thing the value meets.
    expect(outcomeForCode('X_ADMIN_DENIED')).toBe('policy-denied');
    expect(outcomeForCode('X_ADMIN_INVALID')).toBe('invalid-args');
    // NOT the same as `X_INPUT_INVALID`, which stays `failed` above: a projected action
    // publishes its whole schema, so input MCP already validated failing there is drift.
    expect(outcomeForCode('X_INPUT_INVALID')).toBe('failed');
  });
});
