// Every confirmation refusal's `fix` is pasted, so each call it names must be one the CURRENT API
// accepts — a fix that still says "approve" after approving began to require `arguments` sends its
// reader into a refusal. The calls are read OUT of the rendered text and driven through the real
// decision action's input schema and `mcpConfirmations`' option names.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import {
  McpConfirmationArgumentsMismatchError,
  McpConfirmationContestedError,
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationPendingError,
  McpConfirmationRejectedError,
  McpConfirmationToolUnknownError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';

const ID = '0190a6d4-1111-7aaa-8bbb-000000000001';
const subject = { id: ID, tool: 'refundOrder', expiresAt: new Date('2026-10-06T09:10:00.000Z') };

const errors: readonly UltimateError[] = [
  new McpConfirmationPendingError({ ...subject, decider: 'confirmRefunds' }),
  new McpConfirmationExpiredError({ ...subject, at: 'call' }),
  new McpConfirmationExpiredError({ ...subject, at: 'decision' }),
  new McpConfirmationRejectedError(subject),
  new McpConfirmationDecidedError({ ...subject, status: 'approved' }),
  new McpConfirmationUnknownError(ID),
  new McpConfirmationToolUnknownError({ unknown: ['x'], known: ['refundOrder'] }),
  new McpConfirmationContestedError('refundOrder'),
  new McpConfirmationArgumentsMismatchError({ ...subject, reason: 'different' }),
];

const decision = mcpConfirmations({
  tools: ['refundOrder'],
  store: memoryConfirmationStore(),
  permission: 'mcp:confirm',
});

/** `confirmations({ id, decision: 'view' })` → the keys it names and the decision literal. */
const decisionCalls = (text: string) =>
  [...text.matchAll(/confirmations\(\{([^}]*)\}\)/g)].map((match) => {
    const body = match[1] ?? '';
    const keys = body.split(',').map((part) => part.split(':')[0]?.trim() ?? '');
    return { keys, decision: /decision:\s*'(\w+)'/.exec(body)?.[1] };
  });

const OPTION_KEYS = [
  'tools',
  'store',
  'permission',
  'check',
  'ttlMs',
  'clock',
  'audit',
  'sealKeys',
];

describe('every confirmation fix names a call the current API accepts', () => {
  for (const error of errors) {
    const text = `${error.fix}\n${error.callerFix ?? ''}`;

    test(`${error.code}: each decision call parses, and an approval carries its arguments`, async () => {
      for (const call of decisionCalls(error.fix).filter((one) => one.decision !== undefined)) {
        const parsed = await decision.input['~standard'].validate({
          id: ID,
          decision: call.decision,
          ...(call.keys.includes('arguments') ? { arguments: {} } : {}),
        });
        expect(parsed.issues).toBeUndefined();
        if (call.decision === 'approve') expect(call.keys).toContain('arguments');
      }
      // Prose may say "approve" only beside the arguments it must carry.
      if (/\bapprove\b/.test(text)) expect(text).toMatch(/arguments/);
    });

    test(`${error.code}: an mcpConfirmations(...) it names uses real options`, () => {
      for (const match of error.fix.matchAll(/(?<!\.)\bmcpConfirmations\(\{\s*(\w+)/g)) {
        expect(OPTION_KEYS).toContain(match[1] ?? '');
      }
    });
  }

  test('PENDING opens with the view, and only then the approval with its arguments', () => {
    const fix = errors[0]?.fix ?? '';
    expect(fix.startsWith("confirmations({ id, decision: 'view' })")).toBe(true);
    expect(fix).toContain("confirmations({ id, decision: 'approve', arguments })");
  });

  test('REJECTED never sends its reader to approve the call that was rejected', () => {
    const fix = errors.find((one) => one.code === 'X_MCP_CONFIRMATION_REJECTED')?.fix ?? '';
    expect(fix).not.toMatch(/approve/);
    expect(fix.startsWith("{ method: 'tools/call'")).toBe(true);
  });
});
