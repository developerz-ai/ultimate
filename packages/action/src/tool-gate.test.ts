// The name-keyed gate table both tool surfaces read: first registered wins, a later one for that
// name is a no-op rather than an error, and `resetActions` empties it with the registry it lives
// beside, so a reload that re-evaluates modules starts clean.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentActor, useContext } from '@ultimat3/core';
import { can, clearPermissions } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { resetActions } from './registry';
import type { ToolGate } from './tool-gate';
import {
  admitActionCaller,
  gatedToolNames,
  knownToolNames,
  noteToolNames,
  registerToolGate,
  toolGateFor,
} from './tool-gate';

afterEach(() => resetActions());
beforeEach(() => clearPermissions());

const gate: ToolGate = (_call, run) => run();
const other: ToolGate = (_call, run) => run();

describe('registerToolGate', () => {
  test('a name answers the gate registered for it; an unnamed tool answers none', () => {
    registerToolGate(['refundOrder'], gate);
    expect(toolGateFor('refundOrder')).toBe(gate);
    expect(toolGateFor('readOrder')).toBeUndefined();
  });

  test('the first registered keeps the name: a second, even a fresh closure, is a no-op', () => {
    registerToolGate(['refundOrder'], gate);
    expect(() => registerToolGate(['refundOrder', 'voidOrder'], other)).not.toThrow();
    expect(toolGateFor('refundOrder')).toBe(gate);
    // First wins per NAME: the rest of that second list is still gated, and by the second gate.
    expect(toolGateFor('voidOrder')).toBe(other);
  });

  test('gatedToolNames is sorted, so what a process registered compares byte for byte', () => {
    registerToolGate(['voidOrder', 'refundOrder'], gate);
    expect(gatedToolNames()).toEqual(['refundOrder', 'voidOrder']);
  });

  test('a name named only by an inherited Object member is not gated', () => {
    expect(toolGateFor('constructor')).toBeUndefined();
  });

  test('resetActions clears the table', () => {
    registerToolGate(['refundOrder'], gate);
    resetActions();
    expect(toolGateFor('refundOrder')).toBeUndefined();
    expect(gatedToolNames()).toEqual([]);
  });
});

describe('noteToolNames', () => {
  test('a tool no action declares is known once noted, sorted, and resetActions clears it', () => {
    noteToolNames(['seatReport', 'kbRead', 'seatReport']);
    expect(knownToolNames()).toEqual(['kbRead', 'seatReport']);
    resetActions();
    expect(knownToolNames()).toEqual([]);
  });
});

describe('admitActionCaller', () => {
  const target = action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: can('order:refund'),
    handle: () => {
      useContext();
      return { ok: true };
    },
  });

  test('throws the denial for an actor the policy refuses, with or without a request', () => {
    const admit = admitActionCaller(target, 'refundOrder');
    expect(() => admit(agentActor({ id: 'a2' }))).toThrow('X_FORBIDDEN');
  });

  test('lets a permitted actor through', () => {
    const admit = admitActionCaller(target, 'refundOrder');
    expect(() => admit(agentActor({ id: 'a1', permissions: ['order:refund'] }))).not.toThrow();
  });
});
