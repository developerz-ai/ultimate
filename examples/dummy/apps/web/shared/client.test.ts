/**
 * unit — `memberQueries` forwards WHO is asking or refuses; it never reads as somebody else.
 *
 * A page `load` reaches this app over HTTP, so a read that forgot the member's cookie was answered
 * by the demo authenticator's default member: every `app/` page loaded ada's view, and mara got 403
 * on her own org's post. Outside a request there is no member to forward, and the answer must be a
 * refusal rather than a read made as nobody in particular.
 */

import { createContext, runWithContext } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { memberHeaders } from './client';

/**
 * A request's context as the pipeline publishes it: core's `Ctx` plus the inbound headers, which
 * are what `useRequestHeader` proves a request by. Spread, because core's context is frozen.
 */
const inRequest = <T>(headers: HeadersInit, fn: () => T): T =>
  runWithContext({ ...createContext(), requestHeaders: new Headers(headers) }, fn);

test("a member read carries the inbound cookie — the member's, onto the app's own origin", () => {
  const cookie = 'postly_demo_member=mara; locale=es';
  expect(inRequest({ cookie }, memberHeaders)).toEqual({ cookie });
});

test('a request that sent no cookie forwards none, rather than an empty header', () => {
  expect(inRequest({ accept: 'text/html' }, memberHeaders)).toEqual({});
});

test('outside a request it refuses by name instead of reading as the default member', () => {
  const refused = (() => {
    try {
      memberHeaders();
      return expect.unreachable('a member read ran with no member to forward');
    } catch (error) {
      return error;
    }
  })();
  expect(refused).toMatchObject({ code: expect.stringMatching(/^X_NO_(REQUEST|CONTEXT)$/) });
});
