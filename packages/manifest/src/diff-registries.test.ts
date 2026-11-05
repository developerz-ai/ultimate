// The two declaration registries the diff never opened: `policies` and `errorCodes`. Deleting
// every error code in the manifest reported `buildId: content changed` and nothing else.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixture';
import { diffDeclaredErrors } from './diff-registries';

type Policy = NonNullable<ManifestSources['policies']>[number];

const policy = (overrides: Partial<Policy> = {}): readonly Policy[] => [
  {
    permission: 'post:publish',
    description: 'publish a draft',
    enforcedIn: ['actions.publish'],
    ...overrides,
  },
];

const diff = (overrides: Partial<ManifestSources>) =>
  diffManifest(fixtureManifest(), fixtureManifest(overrides));

describe('policies', () => {
  test('a removed policy is breaking — the rule it names is enforced nowhere', () => {
    const changed = diff({ policies: [] });
    expect(changed.hasBreaking).toBe(true);
    expect(changed.breaking.map((c) => c.path)).toContain('policies.post:publish');
  });

  test('an added policy is additive', () => {
    const changed = diffManifest(
      fixtureManifest({ policies: [] }),
      fixtureManifest({ policies: policy() }),
    );
    expect(changed.hasBreaking).toBe(false);
    expect(changed.additive.map((c) => c.path)).toContain('policies.post:publish');
  });

  test('a new enforcement site is breaking; one dropped is additive but reported', () => {
    const gained = diff({ policies: policy({ enforcedIn: ['actions.publish', 'queries.feed'] }) });
    expect(gained.breaking.map((c) => c.path)).toContain(
      'policies.post:publish.enforcedIn.queries.feed',
    );

    const lost = diff({ policies: policy({ enforcedIn: [] }) });
    expect(lost.hasBreaking).toBe(false);
    expect(lost.additive.map((c) => c.path)).toContain(
      'policies.post:publish.enforcedIn.actions.publish',
    );
  });

  test('a changed description is internal', () => {
    const changed = diff({ policies: policy({ description: 'publish it' }) });
    expect(changed.internal.map((c) => c.path)).toContain('policies.post:publish.description');
  });
});

describe('errorCodes', () => {
  test('a removed code is breaking — a caller matching on it stops matching', () => {
    const changed = diff({ errorCodes: [] });
    expect(changed.hasBreaking).toBe(true);
    expect(changed.breaking.map((c) => c.path)).toContain('errorCodes.X_NOT_FOUND');
  });

  test('an added code is additive', () => {
    const changed = diffManifest(
      fixtureManifest({ errorCodes: [] }),
      fixtureManifest({ errorCodes: [{ code: 'X_NOT_FOUND', package: 'app' }] }),
    );
    expect(changed.hasBreaking).toBe(false);
    expect(changed.additive.map((c) => c.path)).toContain('errorCodes.X_NOT_FOUND');
  });

  test('a code that changes owner is internal — the code is what a caller matches on', () => {
    const changed = diff({ errorCodes: [{ code: 'X_NOT_FOUND', package: 'billing' }] });
    expect(changed.hasBreaking).toBe(false);
    expect(changed.internal.map((c) => c.path)).toContain('errorCodes.X_NOT_FOUND.package');
  });

  test('an unchanged registry reports nothing of its own', () => {
    const same = diffManifest(fixtureManifest(), fixtureManifest());
    expect(
      same.changes.filter(
        (c) => c.path.startsWith('errorCodes.') || c.path.startsWith('policies.'),
      ),
    ).toEqual([]);
  });
});

// 39-action-declared-errors: an operation's `errors:` is a list a caller branches on, code by code.
describe('declared errors on an operation', () => {
  const at = 'actions.refundOrder';

  test('a removed declared code is breaking, an added one additive', () => {
    const changes = diffDeclaredErrors(at, ['X_LATE', 'X_SMALL'], ['X_LATE', 'X_TOO_BIG']);
    expect(changes).toEqual([
      { kind: 'breaking', path: `${at}.errors.X_SMALL`, detail: expect.any(String) },
      { kind: 'additive', path: `${at}.errors.X_TOO_BIG`, detail: expect.any(String) },
    ]);
  });

  test('the same list, in any order, is no change; both absent is none', () => {
    expect(diffDeclaredErrors(at, ['X_B', 'X_A'], ['X_A', 'X_B'])).toEqual([]);
    expect(diffDeclaredErrors(at, undefined, undefined)).toEqual([]);
  });

  test('declaring a list is additive; dropping the list is breaking', () => {
    expect(diffDeclaredErrors(at, undefined, ['X_A'])).toEqual([
      { kind: 'additive', path: `${at}.errors`, detail: expect.any(String) },
    ]);
    expect(diffDeclaredErrors(at, ['X_A'], undefined)).toEqual([
      { kind: 'breaking', path: `${at}.errors`, detail: expect.any(String) },
    ]);
  });
});
