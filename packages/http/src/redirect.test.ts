// The intent slot exists because an action's return value is its output schema on every
// surface. These pin the two halves the projection depends on: it survives the handler, and it
// does not survive being read.
import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, createRequestContext } from './context';
import { setRedirect, takeRedirect } from './redirect';

const config = defineHttpConfig();

const context = () =>
  createRequestContext({
    url: new URL('https://example.com/api/sessions/create'),
    method: 'POST',
    role: 'web',
    config,
  });

describe('setRedirect / takeRedirect', () => {
  test('a fresh context has no redirect', () => {
    expect(takeRedirect(context())).toBeUndefined();
  });

  test('303 by default — a form POST must not repost on reload', () => {
    const ctx = context();
    runWithContext(asCtx(ctx), () => setRedirect('/feed'));
    expect(takeRedirect(ctx)).toEqual({ location: '/feed', status: 303 });
  });

  test('an explicit status is kept', () => {
    const ctx = context();
    runWithContext(asCtx(ctx), () => setRedirect('/sign-in', 307));
    expect(takeRedirect(ctx)).toEqual({ location: '/sign-in', status: 307 });
  });

  test('taking it clears it, so nothing downstream redirects a second time', () => {
    const ctx = context();
    runWithContext(asCtx(ctx), () => setRedirect('/feed'));
    expect(takeRedirect(ctx)?.location).toBe('/feed');
    expect(takeRedirect(ctx)).toBeUndefined();
  });

  test('the last call wins — a handler may change its mind before it returns', () => {
    const ctx = context();
    runWithContext(asCtx(ctx), () => {
      setRedirect('/feed');
      setRedirect('/onboarding');
    });
    expect(takeRedirect(ctx)?.location).toBe('/onboarding');
  });

  test('outside a request it is core’s X_NO_CONTEXT, never a silent no-op', () => {
    expect(() => setRedirect('/feed')).toThrow('X_NO_CONTEXT');
  });

  // A job's context is frozen, so the raw write is `TypeError: object is not extensible` — a
  // throw with no code, no cause and no fix. X_NO_REQUEST is the instruction it should be.
  test('a job context refuses with X_NO_REQUEST, not a bare TypeError', () => {
    expect(() => runWithContext(createContext({ role: 'worker' }), () => setRedirect('/feed'))) //
      .toThrow('X_NO_REQUEST');
  });
});
