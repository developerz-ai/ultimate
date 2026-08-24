import { describe, expect, test } from 'bun:test';
import { traceHeaders } from './client-wire';
import { frozenClock } from './clock';
import { createContext, runWithContext, withChildContext } from './context';
import { budgetHeaders, REQUEST_TIMEOUT_HEADER, remainingBudgetMs } from './request-budget';

const at = (iso: string): ReturnType<typeof frozenClock> => frozenClock(new Date(iso));

describe('the remaining budget', () => {
  test('is what is left of the deadline on this context clock', () => {
    const clock = at('2026-08-24T10:00:00.000Z');
    const ctx = createContext({ clock, deadlineAt: clock.now().getTime() + 5_000 });
    expect(remainingBudgetMs(ctx)).toBe(5_000);
  });

  test('is undefined when nothing declared a deadline', () => {
    expect(remainingBudgetMs(createContext({}))).toBeUndefined();
  });

  // A budget already spent is not a budget: `resolveTimeoutMs` on the far side ignores anything
  // under 1ms and falls back to ITS configured value, so sending `0` would read as "no ask".
  test('is undefined once the deadline has passed', () => {
    const clock = at('2026-08-24T10:00:00.000Z');
    expect(
      remainingBudgetMs(createContext({ clock, deadlineAt: clock.now().getTime() - 1 })),
    ).toBeUndefined();
  });

  test('a child context inherits the parent deadline — one request, one budget', () => {
    const clock = at('2026-08-24T10:00:00.000Z');
    const parent = createContext({ clock, deadlineAt: clock.now().getTime() + 7_000 });
    const seen = runWithContext(parent, () =>
      withChildContext({ locale: 'fr' }, () => remainingBudgetMs(createContext({ clock }))),
    );
    // The child built by `withChildContext` is the one that must carry it, not a fresh context.
    expect(seen).toBeUndefined();
    expect(
      runWithContext(parent, () => withChildContext({ locale: 'fr' }, () => budgetHeaders())),
    ).toEqual({ [REQUEST_TIMEOUT_HEADER]: '7000' });
  });
});

describe('what a typed client puts on the wire', () => {
  test('carries the remaining budget, so the next hop cannot start a fresh one', () => {
    const clock = at('2026-08-24T10:00:00.000Z');
    const ctx = createContext({ clock, deadlineAt: clock.now().getTime() + 2_500 });
    expect(runWithContext(ctx, () => traceHeaders())[REQUEST_TIMEOUT_HEADER]).toBe('2500');
  });

  test('sends no budget header outside a request, and none for a context with no deadline', () => {
    expect(traceHeaders()[REQUEST_TIMEOUT_HEADER]).toBeUndefined();
    expect(
      runWithContext(createContext({}), () => traceHeaders())[REQUEST_TIMEOUT_HEADER],
    ).toBeUndefined();
  });
});
