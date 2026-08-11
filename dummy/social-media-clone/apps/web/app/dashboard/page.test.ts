import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(config.render).toBe('ssr');
  expect(config.policy?.permission).toBe('dashboard:read');
  expect(config.offline).toBe('runtime');
});
