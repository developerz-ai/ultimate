// The audit trail's verb column. `AuditEntry.operation` holds a CRUD verb for `kind: 'operation'`
// and the ACTION NAME for `kind: 'action'`, and only the first has a catalog namespace — so one
// template for both rendered `admin.operation.post.publish` verbatim into the page.

import { describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AuditEntry } from './audit';
import { operationLabel } from './detail';

// Distinctive probe values, registered flat: the framework catalog owns `admin.operation.*` and
// an APP owns `admin.action.*` — the same namespace `action-gate.ts` builds a button's `labelKey`
// in — so what is being pinned here is WHICH namespace each entry kind reads from.
registerCatalog('en', {
  'admin.operation.update': 'updated (probe)',
  'admin.action.post.publish': 'published (probe)',
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 'a1',
  at: '2026-08-19T00:00:00.000Z',
  requestId: 'req_1',
  actor: { id: 'u_1', roles: [] },
  operation: 'update',
  kind: 'operation',
  entity: 'post',
  entityId: 'p1',
  permission: 'admin:write',
  outcome: 'allowed',
  reason: 'admin.policy.all-granted',
  diff: [],
  ...over,
});

describe('the audit trail renders a verb, never a raw catalog key', () => {
  test('an operation entry reads out of admin.operation.*', () => {
    expect(operationLabel(entry({ operation: 'update', kind: 'operation' }))).toBe(
      'updated (probe)',
    );
  });

  test('an action entry reads out of admin.action.*, where its name actually lives', () => {
    const label = operationLabel(entry({ operation: 'post.publish', kind: 'action' }));
    expect(label).toBe('published (probe)');
    expect(label).not.toContain('admin.operation.');
  });

  test('an unknown action name still resolves under the action namespace', () => {
    // Not a translation — the missing-key marker. What matters is WHICH key was asked for: a
    // catalog gap in an app is fixable; asking `admin.operation.<action>` never is.
    const label = operationLabel(entry({ operation: 'post.archive', kind: 'action' }));
    expect(label).toContain('admin.action.post.archive');
    expect(label).not.toContain('admin.operation.');
  });
});
