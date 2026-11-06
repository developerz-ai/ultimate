// The origin absolute URLs are built from: `APP_URL`, else the loopback value `.env.example` sets.
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { appOrigin } from './app-origin';

const saved = Bun.env['APP_URL'];
afterEach(() => {
  if (saved === undefined) delete Bun.env['APP_URL'];
  else Bun.env['APP_URL'] = saved;
});

unitTest('APP_URL when set, the loopback default when unset or empty', () => {
  Bun.env['APP_URL'] = 'https://postly.example';
  expect(appOrigin()).toBe('https://postly.example');
  Bun.env['APP_URL'] = '';
  expect(appOrigin()).toBe('http://localhost:3000');
  delete Bun.env['APP_URL'];
  expect(appOrigin()).toBe('http://localhost:3000');
});
