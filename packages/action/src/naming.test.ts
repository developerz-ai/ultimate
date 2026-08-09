import { describe, expect, test } from 'bun:test';
import { derivePath, inputSchemaName, pluralize, toToolName } from './naming';

describe('action name -> route path', () => {
  const cases: readonly [string, string][] = [
    ['publishPost', '/api/posts/publish'],
    ['publishPosts', '/api/posts/publish'],
    ['updateUserProfile', '/api/user-profiles/update'],
    ['likePost', '/api/posts/like'],
    ['createOrgInvite', '/api/org-invites/create'],
    ['archiveEntry', '/api/entries/archive'],
    ['inviteMan', '/api/men/invite'],
    ['checkout', '/api/checkouts/invoke'],
  ];

  for (const [name, path] of cases) {
    test(`${name} -> POST ${path}`, () => {
      expect(derivePath(name).path).toBe(path);
    });
  }

  test('verb and resource are exposed separately for OpenAPI tags', () => {
    expect(derivePath('publishPost')).toEqual({
      verb: 'publish',
      resource: 'posts',
      path: '/api/posts/publish',
    });
  });

  test('tool and component names derive from the same words', () => {
    expect(toToolName('updateUserProfile')).toBe('update_user_profile');
    expect(inputSchemaName('updateUserProfile')).toBe('UpdateUserProfileInput');
  });

  test('pluralize leaves an already-plural word alone', () => {
    expect(pluralize('posts')).toBe('posts');
    expect(pluralize('entry')).toBe('entries');
    expect(pluralize('box')).toBe('boxes');
  });
});
