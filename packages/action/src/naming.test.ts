import { describe, expect, test } from 'bun:test';
import { derivePath, inputSchemaName, pluralize } from './naming';

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

  test('component names derive from the same words the path does', () => {
    expect(inputSchemaName('updateUserProfile')).toBe('UpdateUserProfileInput');
  });

  test('pluralize leaves an already-plural word alone', () => {
    expect(pluralize('posts')).toBe('posts');
    expect(pluralize('entry')).toBe('entries');
    expect(pluralize('box')).toBe('boxes');
  });
});

/**
 * `IRREGULAR[word]` read the plural off the prototype chain. `splitWords` lowercases, which is
 * what keeps `toString` and `hasOwnProperty` out of reach — `constructor` is already lowercase and
 * survived, so `pluralize` answered the `Object` FUNCTION where its return type says `string`, and
 * every projection that derives a path from the name published it: the route, the OpenAPI `paths`
 * entry and its `tags`, and `client.ts`'s own derivation.
 */
describe('a word is looked up in the irregular table, never on Object.prototype', () => {
  test('pluralize answers a string for every key Object.prototype carries', () => {
    for (const word of ['constructor', 'valueOf', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(typeof pluralize(word)).toBe('string');
    }
    expect(pluralize('constructor')).toBe('constructors');
  });

  test('the path derived for such a name is still a path', () => {
    expect(derivePath('addConstructor').path).toBe('/api/constructors/add');
  });

  test('the real irregular plurals still answer', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('datum')).toBe('data');
  });
});
