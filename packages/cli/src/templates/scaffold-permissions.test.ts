// One rule over every file the generators emit: a permission a scaffolded app GRANTS or REQUIRES
// must be a permission that same app DECLARES. `defineRoles()` accepts an undeclared grant in
// silence and `RouteGuard.permission` is a bare string, so nothing between `x new` and a browser
// asked the question — and the answer was no: `dashboard:read` was granted by `scaffold-roles.ts`,
// required by `scaffold-app.ts`, and declared by nobody, so a fresh scaffold served HTTP 500 with
// X_PERMISSION_UNKNOWN on two of its three routes under a green gate.

import { describe, expect, test } from 'bun:test';
import { scaffoldVariants } from '../scaffold-fixture';

interface EmittedText {
  readonly variant: string;
  readonly path: string;
  readonly contents: string;
}

const emitted = (): readonly EmittedText[] =>
  scaffoldVariants().flatMap((variant) =>
    variant.files.flatMap((file) =>
      typeof file.contents === 'string'
        ? [{ variant: variant.name, path: file.path, contents: file.contents }]
        : [],
    ),
  );

/**
 * A test file is not the app: its actors carry direct `permissions: [...]` that deliberately name
 * grants no role holds, which is the point of the fixture. Only shipped source is judged, exactly
 * as `workspace-graph.ts` judges only shipped imports.
 */
const isShipped = (path: string): boolean => !/\.test\.tsx?$/.test(path);

const PERMISSION = /'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g;

/** Every string inside one `definePermissions([...])` argument. */
const declaredIn = (source: string): readonly string[] =>
  [...source.matchAll(/definePermissions\(\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...(match[1] ?? '').matchAll(PERMISSION)].map((entry) => entry[1] ?? ''),
  );

/** Every string inside one `grants: [...]` — what `defineRoles()` never checks. */
const grantedIn = (source: string): readonly string[] =>
  [...source.matchAll(/grants:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...(match[1] ?? '').matchAll(PERMISSION)].map((entry) => entry[1] ?? ''),
  );

/** Every `policy: { permission: '…' }` a `defineRoute` declares — a bare string to the framework. */
const requiredIn = (source: string): readonly string[] =>
  [...source.matchAll(/permission:\s*'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g)].map(
    (match) => match[1] ?? '',
  );

describe('unit · a scaffolded app declares every permission it grants and requires', () => {
  const references = (
    read: (source: string) => readonly string[],
  ): readonly { at: string; permission: string }[] =>
    scaffoldVariants().flatMap((variant) => {
      const declared = new Set(
        variant.files.flatMap((file) =>
          typeof file.contents === 'string' ? declaredIn(file.contents) : [],
        ),
      );
      return emitted()
        .filter((file) => file.variant === variant.name && isShipped(file.path))
        .flatMap((file) =>
          read(file.contents)
            .filter((permission) => !declared.has(permission))
            .map((permission) => ({ at: `${file.variant}: ${file.path}`, permission })),
        );
    });

  test('every permission a scaffolded role grants is declared', () => {
    expect(references(grantedIn)).toEqual([]);
  });

  test('every permission a scaffolded route requires is declared', () => {
    expect(references(requiredIn)).toEqual([]);
  });

  test('the readers see the scaffold at all — a rule matching nothing enforces nothing', () => {
    const files = emitted().filter((file) => file.path === 'apps/web/shared/roles.ts');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(declaredIn(file.contents).length).toBeGreaterThan(0);
      expect(grantedIn(file.contents).length).toBeGreaterThan(0);
    }
    expect(
      emitted().flatMap((file) => (isShipped(file.path) ? requiredIn(file.contents) : [])).length,
    ).toBeGreaterThan(0);
  });
});
