// The event's whole reason to exist is the ALLOW: a denial already reaches a surface as a 403,
// and "who was let in, and which rule let them" was the half nothing recorded. These tests lead
// with that path, then pin the two properties an audit log is worthless without — it never
// carries row data, and it is one bus event every subscriber hears, not a single slot.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PolicyDecisionEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { decisionObserved } from './decisions';
import { evaluate, resetPolicyTracing } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { and, can } from './policy';
import { clearRoles, defineRoles } from './roles';
import { enforceHttp } from './surfaces';
import { testActor } from './test-kit';

interface Input {
  readonly postId: string;
}

interface Post {
  readonly authorId: string;
  readonly secret: string;
}

const input: Input = { postId: 'p1' };
const row: Post = { authorId: 'editor', secret: 'ssn-123-45-6789' };

/** What a subscriber heard, in emit order. */
const sink = { events: [] as PolicyDecisionEvent[] };

beforeEach(() => {
  clearPermissions();
  clearRoles();
  resetPolicyTracing();
  definePermissions(['post:publish', 'org:administer'] as const);
  defineRoles({ editor: { grants: ['post:publish'] } });
  sink.events.length = 0;
  subscribe('policy.decision', (event) => void sink.events.push(event.payload));
});

afterEach(() => {
  resetInstrumentation();
  clearPermissions();
  clearRoles();
  resetPolicyTracing();
});

const editor = testActor('editor', { roles: ['editor'], orgId: 'org-1' }).actor;
const guest = testActor('guest', { roles: [] }).actor;

describe('the policy.decision event', () => {
  test('an ALLOWED decision reaches subscribers — the path an audit log actually needs', () => {
    const policy = can<Input, Post>('post:publish');
    expect(evaluate(policy, { input, actor: editor, row }).allowed).toBe(true);

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0] as PolicyDecisionEvent;
    expect(event.allowed).toBe(true);
    expect(event.label).toBe('post:publish');
    expect(event.actorId).toBe('editor');
    expect(event.orgId).toBe('org-1');
    expect(event.code).toBeNull();
    expect(event.deciding).toBe('post:publish');
  });

  test('never carries the row or the input — the PII guarantee reason already makes', () => {
    const policy = can<Input, Post>('post:publish', ({ row: loaded }) => loaded?.secret === 'no');
    evaluate(policy, { input, actor: editor, row });
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain('ssn-123-45-6789');
    expect(serialized).not.toContain('p1');
  });

  test('a surface adapter tags the event with its own surface, without a second emit', () => {
    enforceHttp(can<Input>('post:publish'), { input, actor: guest });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.surface).toBe('http');
    expect(sink.events[0]?.allowed).toBe(false);
    expect(sink.events[0]?.code).toBe('X_FORBIDDEN');
  });

  test('a composite label and the deciding clause both survive to the event', () => {
    evaluate(and(can<Input>('post:publish'), can<Input>('org:administer')), {
      input,
      actor: editor,
    });
    expect(sink.events[0]?.label).toBe('and(post:publish, org:administer)');
    expect(sink.events[0]?.deciding).toBe('org:administer');
  });

  test('every subscriber hears the decision — a second one replaces nobody', () => {
    const second: PolicyDecisionEvent[] = [];
    subscribe('policy', (event) => void second.push(event.payload));
    evaluate(can<Input>('post:publish'), { input, actor: editor });
    expect(sink.events).toHaveLength(1);
    expect(second).toEqual(sink.events);
  });

  test('with no subscriber nothing is recorded and nothing is asked for', () => {
    resetInstrumentation();
    expect(decisionObserved()).toBe(false);
    evaluate(can<Input>('post:publish'), { input, actor: editor });
    expect(sink.events).toHaveLength(0);
  });
});
