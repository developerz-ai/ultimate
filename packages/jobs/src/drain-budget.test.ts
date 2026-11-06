// A drain budget only ever tightens: `deadlineAt` reads the bound one, a later bind can only move it
// earlier, and a watcher hears the bound deadline at once and each tightening after.

import { describe, expect, test } from 'bun:test';
import { createDrainBudget } from './drain-wait';

describe('createDrainBudget', () => {
  test('deadlineAt is unbound until bound, then only ever moves earlier', () => {
    const budget = createDrainBudget();
    expect(budget.deadlineAt).toBeUndefined();
    budget.bind(500);
    expect(budget.deadlineAt).toBe(500);
    budget.bind(900);
    expect(budget.deadlineAt).toBe(500);
    budget.bind(200);
    expect(budget.deadlineAt).toBe(200);
  });

  test('a watcher hears the bound deadline now and each tightening, until it unsubscribes', () => {
    const budget = createDrainBudget(1_000);
    const heard: number[] = [];
    const stop = budget.watch((at) => heard.push(at));
    budget.bind(1_500);
    budget.bind(400);
    stop();
    budget.bind(100);
    expect(heard).toEqual([1_000, 400]);
    expect(budget.deadlineAt).toBe(100);
  });
});
