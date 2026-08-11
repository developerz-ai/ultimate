import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('the landing page ships zero JS and declares metadata', async () => {
  expect(config.render).toBe('static');
  expect(config.hydrate).toBe('never');
  expect(config.budget.js).toBe('0kb');
  const meta = await config.meta({});
  expect(meta.title ?? '').not.toBe('');
});
