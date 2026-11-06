// The runtime loads under test and hands both boots the partner authorization server's routes.
import { expect, unitTest } from '@ultimat3/testing';
import { partnerOAuth } from './app/partners/oauth';
import { runtime } from './runtime';

unitTest('the runtime loads and mounts the authorization server routes', () => {
  expect(runtime.routes).toBe(partnerOAuth.routes);
});
