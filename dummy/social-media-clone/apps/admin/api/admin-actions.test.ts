// The three decisions the write door makes before and after the policy: which action was posted,
// where the browser lands, and which audience answered. All pure, so they are asserted without a
// request — the wire itself is `admin-actions.contract.test.ts`, over the real pipeline.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { ADMIN_ACTION_ROUTE, landsInBrowser } from '../shared/action-route';
import { adminActionFor, landingFor } from './admin-actions';

const failure = (run: () => unknown): { code: string; fix: string } => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, fix: error.fix };
    return { code: String(error), fix: '' };
  }
  return { code: 'no error', fix: '' };
};

// Failure first: a name nothing registered must be refused before any decision is asked, and the
// refusal must name a value that would have worked — "unknown action" alone is not an instruction.
test('a posted name no action declares is refused, and the fix names one that exists', () => {
  const refused = failure(() => adminActionFor('user.deport'));
  expect(refused.code).toBe('X_ADMIN_ACTION_UNKNOWN');
  expect(refused.fix).toContain('user.suspend');
});

test('the posted name resolves against the registry defineAdmin built, with its entity', () => {
  const resolved = adminActionFor('user.suspend');
  expect(resolved.entity).toBe('users');
  expect(resolved.action.permission).toBe('users:suspend');
});

test('the browser lands back on the screen it pressed from — read off the route table', () => {
  expect(landingFor('users')).toBe('/admin/users');
  expect(landingFor('media')).toBe('/admin/media');
  // An app-wide action has no resource screen; the dashboard root is the only honest fallback.
  expect(landingFor('admin')).toBe('/admin');
});

test('the two audiences split on accept, and only on accept', () => {
  expect(landsInBrowser('text/html,application/xhtml+xml')).toBe(true);
  expect(landsInBrowser('application/json')).toBe(false);
  // An agent that sends no accept header gets the output schema, never a 303 it cannot follow.
  expect(landsInBrowser(null)).toBe(false);
});

test('the form posts at the path the action derives — one URL, derived, never typed twice', () => {
  expect(ADMIN_ACTION_ROUTE).toBe('/api/admin-actions/run');
});
