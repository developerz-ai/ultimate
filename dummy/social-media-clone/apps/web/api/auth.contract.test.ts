// contract — the shape the sign-in and sign-up FORMS depend on. Not an implementation detail: a
// `site/` page may not import `api/`, so the pages write the derived paths into `action=` by hand.
// This test is the join between the two, and a rename that moves a path fails here rather than in
// a browser.

import { toRoute } from '@ultimat3/action';
import { contractTest, expect } from '@ultimat3/testing';
import { createAccount, createSession, destroySession } from './auth';

const named = {
  createSession: createSession.named('createSession'),
  createAccount: createAccount.named('createAccount'),
  destroySession: destroySession.named('destroySession'),
};

contractTest('the derived paths are the ones the forms post at', () => {
  expect(toRoute(named.createSession).path).toBe('/api/sessions/create');
  expect(toRoute(named.createAccount).path).toBe('/api/accounts/create');
  expect(toRoute(named.destroySession).path).toBe('/api/sessions/destroy');
  for (const target of Object.values(named)) expect(toRoute(target).method).toBe('POST');
});

contractTest('all three are public by declaration, and none is an MCP tool', () => {
  for (const target of Object.values(named)) {
    // `allow('public')` said out loud. A missing policy is a build error, so "anyone may call
    // this" has to be a declaration too — and `auth: 'public'` on the route follows from it.
    expect(target.policy.kind).toBe('allow');
    expect(toRoute(target).meta.auth).toBe('public');
    // Deliberately not exposed. An agent that could mint a session cookie for any handle would be
    // a second authentication path, reachable without a browser.
    expect(target.mcp?.expose).toBe(false);
  }
});

contractTest('sign-out declares a field, so an empty form body cannot 422', () => {
  // A `<form method="post">` with no inputs sends `content-length: 0`, which the pipeline reads
  // as no body and refuses against an object schema (`packages/http/src/pipeline.ts:255`). The
  // literal below is exactly what the hidden input in `site/signin/page.tsx` sends.
  expect(named.destroySession.input.parse({ confirm: 'sign-out' })).toEqual({
    confirm: 'sign-out',
  });
  expect(() => named.destroySession.input.parse({})).toThrow();
});

contractTest('a session response tells a JS-less browser where to go next', () => {
  // The action cannot answer a form POST with a 303 — `toRoute` wraps every return value in
  // `json()` (`packages/action/src/http.ts:54`), so `next` is the redirect target as DATA. A
  // caller that ignores it lands on the JSON body, which is the framework gap this names.
  const shape = named.createSession.output.parse({ ok: true, next: '/feed', handle: 'user' });
  expect(shape.next).toBe('/feed');
});
