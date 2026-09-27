import { describe, expect, test } from 'bun:test';
import { actionPath, actionRoute, pluralize, queryPath } from './client-paths';

describe('actionPath', () => {
  test.each([
    ['publishPost', '/api/posts/publish'],
    ['publishPosts', '/api/posts/publish'],
    ['updateUserProfile', '/api/user-profiles/update'],
    ['likePost', '/api/posts/like'],
    ['checkout', '/api/checkouts/invoke'],
    ['addPerson', '/api/people/add'],
    ['tagBox', '/api/boxes/tag'],
    ['listCategory', '/api/categories/list'],
    ['SYNC_HTTP_URL', '/api/http-urls/sync'],
  ])('%s -> %s', (name, path) => {
    expect(actionPath(name)).toBe(path);
  });

  test('carries verb and resource beside the path', () => {
    expect(actionRoute('updateUserProfile')).toEqual({
      verb: 'update',
      resource: 'user-profiles',
      path: '/api/user-profiles/update',
    });
  });

  test('a prototype member is a word, never the Object function', () => {
    expect(pluralize('constructor')).toBe('constructors');
  });
});

describe("actionPath, 'readable' style", () => {
  test.each([
    ['signIn', '/api/sign-in'],
    ['signUp', '/api/sign-up'],
    ['health', '/api/health'],
    ['subscribe', '/api/subscribe'],
    ['viewCustomer360', '/api/view-customer360'],
    ['viewAsOrg', '/api/view-as-org'],
    ['adminCreateCoupon', '/api/admin-create-coupon'],
    ['recordManualPayout', '/api/record-manual-payout'],
    ['publishPost', '/api/publish-post'],
    ['SYNC_HTTP_URL', '/api/sync-http-url'],
  ])('%s -> %s', (name, path) => {
    expect(actionPath(name, 'readable')).toBe(path);
  });

  test('no plural is forced and verb/resource are the name split, not a guess', () => {
    expect(actionRoute('updateUserProfile', 'readable')).toEqual({
      verb: 'update',
      resource: 'user-profile',
      path: '/api/update-user-profile',
    });
    expect(actionRoute('health', 'readable')).toEqual({
      verb: 'health',
      resource: 'health',
      path: '/api/health',
    });
  });

  test("the default is still 'resource' — an app that declares nothing keeps every URL", () => {
    expect(actionPath('signIn')).toBe('/api/ins/sign');
    expect(actionPath('signIn', 'resource')).toBe('/api/ins/sign');
  });
});

describe('queryPath', () => {
  test.each([
    ['liveFeed', '/_x/query/live-feed'],
    ['posts', '/_x/query/posts'],
    ['HTMLReport', '/_x/query/html-report'],
    ['org_members', '/_x/query/org-members'],
  ])('%s -> %s', (name, path) => {
    expect(queryPath(name)).toBe(path);
  });
});
