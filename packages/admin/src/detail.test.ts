// The audit trail's verb column. `AuditEntry.operation` holds a CRUD verb for `kind: 'operation'`
// and the ACTION NAME for `kind: 'action'`, and only the first has a catalog namespace — so one
// template for both rendered `admin.operation.post.publish` verbatim into the page.

import { describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AuditEntry } from './audit';

// Dynamic, and paired: `detail.tsx` contains a `<>` whose fragment factory only exists once
// `@ultimat3/render`'s `Bun.plugin` is installed, and a plugin only transforms modules loaded
// AFTER it. A STATIC import here transformed the view with the classic fallback and cached it, so
// whichever of this file and `detail-render.test.ts` ran first decided whether the other could
// render at all. Neither file may reach `detail.tsx` any other way.
await import('@ultimat3/render');
const { operationLabel } = await import('./detail');

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
