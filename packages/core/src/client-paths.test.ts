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
