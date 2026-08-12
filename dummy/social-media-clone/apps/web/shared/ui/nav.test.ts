// The navigation model's two rules, tested without a renderer: what a viewer is offered, and which
// item is current. Both are decisions, and a decision that only exists inside JSX is untestable.

import { expect, test } from 'bun:test';
import { isCurrent, navFor, pathnameOf } from './nav';

test('unit · a signed-out visitor is offered only the route they can actually open', () => {
  expect(navFor(false).map((item) => item.href)).toEqual(['/feed']);
});

test('unit · signing in adds the four gated screens, feed still first', () => {
  expect(navFor(true).map((item) => item.href)).toEqual([
    '/feed',
    '/dashboard',
    '/friends',
    '/messages',
    '/notifications',
  ]);
});

test('unit · a thread is still inside Messages, and a lookalike prefix is not', () => {
  expect(isCurrent('/messages', '/messages')).toBe(true);
  expect(isCurrent('/messages', '/messages/abc-123')).toBe(true);
  // The bug a bare `startsWith` ships: `/messages-archive` would light up "Messages".
  expect(isCurrent('/messages', '/messages-archive')).toBe(false);
  expect(isCurrent('/messages', '/feed')).toBe(false);
});

test('unit · home matches exactly, so every page is not "the landing page"', () => {
  expect(isCurrent('/', '/')).toBe(true);
  expect(isCurrent('/', '/feed')).toBe(false);
});

test('unit · the path is taken from an absolute url, and a bad one never throws', () => {
  expect(pathnameOf('https://demo.test/messages/abc?x=1')).toBe('/messages/abc');
  expect(pathnameOf('/feed')).toBe('/feed');
  expect(pathnameOf(undefined)).toBe('/');
  expect(pathnameOf('not a url')).toBe('/');
});

// `/admin` is a separate surface (`apps/admin`), so it is in no route table this app's header can
// enumerate. It answered 200 for the seeded operator from the day it shipped and was reachable
// only by typing the URL — the exact report was "I logged in as admin and I don't see the admin
// dashboard". A screen nobody can find is a screen that does not exist.
test('unit · an operator is offered the admin dashboard', () => {
  expect(navFor(true, true).map((item) => item.href)).toEqual([
    '/feed',
    '/dashboard',
    '/friends',
    '/messages',
    '/notifications',
    '/admin',
  ]);
});

// The link and the door are one decision (`admin:read`), so a member must be offered neither.
// Rendering it anyway would be a link whose only outcome is a 403.
test('unit · a member without the grant is offered nothing extra', () => {
  expect(navFor(true, false).map((item) => item.href)).not.toContain('/admin');
  expect(navFor(false, true).map((item) => item.href)).toEqual(['/feed']);
});
