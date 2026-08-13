// Single responsibility: tests for the statement observer seam itself — install, replace,
// uninstall, and the two guarantees the funnels are written against. Uninstalled must read
// `undefined` (the production path), and an installed observer must be handed back by identity:
// a wrapper here would swallow the throw strict test mode depends on.

import { afterEach, describe, expect, test } from 'bun:test';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver, statementObserver } from './observe';

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

const EVENT: StatementEvent = {
  text: 'select * from members where id = $1',
  values: ['m_1'],
  durationMs: 1.5,
  rows: 1,
};

afterEach(() => {
  setStatementObserver(undefined);
});

describe('statementObserver', () => {
  test('reads undefined when nothing is installed', () => {
    expect(statementObserver()).toBeUndefined();
  });

  test('hands back the installed observer by identity, never a wrapper', () => {
    // The funnels call `.onStatement` on whatever this returns. A guarding facade would contain a
    // throw, and strict test mode is an observer whose throw must fail the test.
    const observer = recorder();
    setStatementObserver(observer);
    expect(statementObserver()).toBe(observer);
  });

  test('propagates a throwing observer to the caller', () => {
    setStatementObserver({
      onStatement(): void {
        throw new Error('n+1 in a strict test');
      },
    });
    expect(() => statementObserver()?.onStatement(EVENT)).toThrow('n+1 in a strict test');
  });

  test('a second install replaces the first, which then sees nothing', () => {
    const first = recorder();
    const second = recorder();
    setStatementObserver(first);
    setStatementObserver(second);
    statementObserver()?.onStatement(EVENT);
    expect(first.seen).toHaveLength(0);
    expect(second.seen).toHaveLength(1);
  });

  test('undefined uninstalls, so the production path is one branch again', () => {
    const observer = recorder();
    setStatementObserver(observer);
    setStatementObserver(undefined);
    statementObserver()?.onStatement(EVENT);
    expect(statementObserver()).toBeUndefined();
    expect(observer.seen).toHaveLength(0);
  });

  test('carries the full event through untouched, attribution and error included', () => {
    const observer = recorder();
    setStatementObserver(observer);
    const failure = new Error('statement failed');
    const event: StatementEvent = {
      text: 'insert into members (id) values ($1)',
      values: ['m_2'],
      durationMs: 0.25,
      rows: 0,
      error: failure,
      attribution: { entity: 'members', op: 'insert' },
    };
    statementObserver()?.onStatement(event);
    expect(observer.seen).toEqual([event]);
    expect(observer.seen[0]?.attribution?.entity).toBe('members');
    expect(observer.seen[0]?.error).toBe(failure);
  });
});
