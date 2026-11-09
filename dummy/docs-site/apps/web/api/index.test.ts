// The registration, read back. `defineApi` names every primitive by its EXPORT, so what this
// pins is that a declaration reached the call at all — an action left out of the list is a route
// that answers 404 with every test of the action itself still green.
import { expect, unitTest } from '@ultimat3/testing';
import { health } from './health';
import { api } from './index';

unitTest('health is registered, as the object its module exports', () => {
  expect(api.actions.health).toBe(health);
  expect(api.actions.health.describe().name).toBe('health');
});
