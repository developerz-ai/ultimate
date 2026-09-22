// A sign-out response clears what the previous principal left in the browser.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_SESSION_POLICY } from './session';
import { SIGN_OUT_CLEAR_SITE_DATA, signOutHeaders } from './sign-out';

describe('signOutHeaders', () => {
  test('always Clear-Site-Data for cache and storage — never cookies, which the response sets', () => {
    const headers = new Headers(signOutHeaders() as [string, string][]);

    expect(headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect(SIGN_OUT_CLEAR_SITE_DATA).not.toContain('cookies');
  });

  test('with the framework session policy, the session cookie is expired in the same response', () => {
    const entries = signOutHeaders({ session: DEFAULT_SESSION_POLICY });
    const cookie = entries.find(([name]) => name === 'set-cookie')?.[1] ?? '';

    expect(cookie).toMatch(/Max-Age=0/i);
    expect(entries.map(([name]) => name)).toEqual(['set-cookie', 'clear-site-data']);
  });
});
