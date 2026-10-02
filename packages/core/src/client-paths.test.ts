import { describe, expect, test } from 'bun:test';
import {
  actionPath,
  actionRoute,
  pluralize,
  queryPath,
  renderedActionPathStyle,
} from './client-paths';
import { CLIENT_PATH_STYLE_META } from './page-meta';

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

/** A document whose `<head>` carries the server's stamp — or, for `undefined`, none at all. */
const withDocument = (content: unknown, run: () => void): void => {
  const doc = {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PATH_STYLE_META}"]` && content !== undefined
        ? { content }
        : null,
  };
  Reflect.set(globalThis, 'document', doc);
  try {
    run();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
};

describe('the path style the server stamped into the document', () => {
  test('is what a browser derives under when the caller names no style', () => {
    withDocument('readable', () => {
      expect(renderedActionPathStyle()).toBe('readable');
      expect(actionPath('signIn')).toBe('/api/sign-in');
    });
  });

  test('never overrides a style the caller passed — that caller is naming another server', () => {
    withDocument('readable', () => {
      expect(actionPath('signIn', 'resource')).toBe('/api/ins/sign');
    });
  });

  test("a document with no stamp was rendered by a 'resource' server", () => {
    withDocument(undefined, () => {
      expect(renderedActionPathStyle()).toBeUndefined();
      expect(actionPath('signIn')).toBe('/api/ins/sign');
    });
  });

  test.each([['READABLE'], [''], ['rest'], [7]])('an unknown stamp %p is no stamp', (content) => {
    withDocument(content, () => {
      expect(renderedActionPathStyle()).toBeUndefined();
      expect(actionPath('signIn')).toBe('/api/ins/sign');
    });
  });

  test('no document at all — a server, a worker, a script — is no stamp', () => {
    expect(Reflect.has(globalThis, 'document')).toBe(false);
    expect(renderedActionPathStyle()).toBeUndefined();
  });

  test('a document that cannot be queried is no stamp, never a throw', () => {
    Reflect.set(globalThis, 'document', {});
    try {
      expect(renderedActionPathStyle()).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('actionRoute stays pure: it never reads the document', () => {
    withDocument('readable', () => {
      expect(actionRoute('signIn').path).toBe('/api/ins/sign');
    });
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
