// The seam a test reaches for when its subject is an EMPTY entity registry — the premise that is
// true only until some other file in the process imports a module that declares an entity.

import { describe, expect, test } from 'bun:test';
import { entity, entityNames, text, uuid } from '@ultimat3/entity';
import { isolateEntityRegistry } from './registry-isolation';

// Registered at module scope, exactly as an app declares its domain — which is what makes it
// present in this process before any test below runs.
const NEIGHBOUR = 'registry_isolation_neighbour';
entity(NEIGHBOUR, { columns: { id: uuid().primaryKey(), title: text({ max: 20 }) } });

describe('isolateEntityRegistry', () => {
  test('hands the caller an empty registry', () => {
    expect(entityNames()).toContain(NEIGHBOUR);

    const restore = isolateEntityRegistry();
    try {
      expect(entityNames()).toEqual([]);
    } finally {
      restore();
    }
  });

  test('puts every entry back, because entity() cannot run a second time', () => {
    const before = [...entityNames()];

    isolateEntityRegistry()();

    expect([...entityNames()]).toEqual(before);
  });

  // `finally`, not a trailing call: a throw from `entity()` or from the assertion above it would
  // otherwise leave the process's registry cleared for every file after this one — the exact bug
  // this helper exists to prevent, written by its own test.
  test('an entity declared inside the isolation does not survive it', () => {
    const restore = isolateEntityRegistry();
    try {
      entity('registry_isolation_temporary', { columns: { id: uuid().primaryKey() } });
      expect(entityNames()).toEqual(['registry_isolation_temporary']);
    } finally {
      restore();
    }

    expect(entityNames()).not.toContain('registry_isolation_temporary');
  });
});
