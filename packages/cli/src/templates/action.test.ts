// The one fact `x g action` reads from the app's disk: whether the slice's `errors.ts` declares the
// `<Feature>NotFoundError` the handler would throw. Measured in ai-maxxing's `fleet` slice, whose
// `errors.ts` declares `HostNotFoundError` and `SessionNotFoundError` and no `FleetNotFoundError`:
// the generated action failed at import, and because `x db gen` and `x manifest` load every
// module, one generated-and-not-yet-edited file made both refuse to run.

import { describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory or a symlink, and loading a generated file for
// real needs both — a sandbox on disk that borrows the workspace's installed packages.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: same — no Bun native answers the platform temp root.
import { join } from 'node:path'; // why: same — the sandbox's paths are joined, never concatenated.
import { HANDWRITTEN_ERRORS } from '../scaffold-fixture';
import { sandboxPath, workspaceRoot } from '../scaffold-typecheck';
import { actionFiles } from './action';
import { sliceExports } from './slice-foundation';

const target = { surfaceDir: 'apps/web/app', feature: 'fleet' } as const;

/** ai-maxxing's `fleet/errors.ts`, reduced to the shape that matters: two classes, neither ours. */
const FLEET_ERRORS = `import { UltimateError } from '@ultimat3/core';

// TODO: a FleetNotFoundError would go here — a comment, and not an export.
export class HostNotFoundError extends UltimateError {
  constructor(input: { id: string }) {
    super({ code: 'X_HOST_NOT_FOUND', cause: \`no host \${input.id}\`, fix: 'x queries list' });
  }
}
export class SessionNotFoundError extends UltimateError {
  constructor(input: { id: string }) {
    super({ code: 'X_SESSION_NOT_FOUND', cause: \`no session \${input.id}\`, fix: 'x queries list' });
  }
}
`;

const sourceOf = (files: ReturnType<typeof actionFiles>, suffix: string): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

describe('unit · sliceExports reads what a slice module exports', () => {
  test('a declared class, const or function counts; a comment or a type does not', () => {
    expect(sliceExports(FLEET_ERRORS, 'HostNotFoundError')).toBe(true);
    expect(sliceExports(FLEET_ERRORS, 'SessionNotFoundError')).toBe(true);
    expect(sliceExports(FLEET_ERRORS, 'FleetNotFoundError')).toBe(false);
    expect(sliceExports('export const FleetNotFoundError = 1;', 'FleetNotFoundError')).toBe(true);
    expect(sliceExports('export function FleetNotFoundError() {}', 'FleetNotFoundError')).toBe(
      true,
    );
    expect(sliceExports('export type FleetNotFoundError = never;', 'FleetNotFoundError')).toBe(
      false,
    );
    expect(sliceExports('class FleetNotFoundError {}', 'FleetNotFoundError')).toBe(false);
  });

  test('an export list counts, under the name it exports AS', () => {
    const listed = 'class Missing {}\nexport { Missing as FleetNotFoundError, other };';
    expect(sliceExports(listed, 'FleetNotFoundError')).toBe(true);
    expect(sliceExports(listed, 'Missing')).toBe(false);
    expect(sliceExports(listed, 'other')).toBe(true);
  });
});

describe('unit · x g action throws the feature error only where the slice declares it', () => {
  test('a slice with no errors.ts yet gets one, and the action throws from it', () => {
    const files = actionFiles('ping-fleet', target);
    const source = sourceOf(files, 'actions/ping-fleet.ts');
    expect(source).toContain("import { FleetNotFoundError } from '../errors';");
    expect(source).toContain('throw new FleetNotFoundError({ id: input.id })');
    expect(sliceExports(sourceOf(files, 'fleet/errors.ts'), 'FleetNotFoundError')).toBe(true);
  });

  test("a slice whose errors.ts declares the class keeps the lookup — the file is the author's", () => {
    const declared = `${FLEET_ERRORS}export class FleetNotFoundError extends HostNotFoundError {}\n`;
    const source = sourceOf(
      actionFiles('ping-fleet', { ...target, sliceErrors: declared }),
      'actions/ping-fleet.ts',
    );
    expect(source).toContain("from '../errors'");
    expect(source).toContain('repo.byId(input.id)');
  });

  for (const [kind, mutator] of [
    ['action', false],
    ['mutator', true],
  ] as const) {
    test(`a slice whose errors.ts lacks the class gets a ${kind} that names no such import`, () => {
      const source = sourceOf(
        actionFiles('ping-fleet', { ...target, mutator, sliceErrors: FLEET_ERRORS }),
        'actions/ping-fleet.ts',
      );
      expect(source).not.toContain("'../errors'");
      expect(source).not.toContain("'../repo'");
      expect(source).not.toContain('throw new');
      // The comment says what the slice is missing, by the name the author would declare.
      expect(source).toContain('declares no FleetNotFoundError');
      expect(source).toContain(`= ${kind}({`);
    });
  }

  test('the generated action loads — the whole defect was a file that did not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-action-'));
    try {
      // The sandbox borrows THIS package's installed dependencies — the `@ultimat3/*` links live
      // per workspace, not at the root, and the typecheck gate maps them through `paths`, which
      // a runtime `import()` never reads. The action imports `@ultimat3/action`; its slice's
      // `../policy` imports two more.
      symlinkSync(
        join(workspaceRoot(), 'packages', 'cli', 'node_modules'),
        join(dir, 'node_modules'),
        'dir',
      );
      for (const file of actionFiles('ping-fleet', { ...target, sliceErrors: FLEET_ERRORS })) {
        await Bun.write(sandboxPath(dir, file.path), file.contents);
      }
      // The app's own errors.ts, as `x g` would have found it — the foundation's is `if-absent`.
      await Bun.write(sandboxPath(dir, 'apps/web/app/fleet/errors.ts'), FLEET_ERRORS);

      const loaded = (await import(
        sandboxPath(dir, 'apps/web/app/fleet/actions/ping-fleet.ts')
      )) as {
        readonly pingFleet: { readonly kind: string };
      };

      expect(loaded.pingFleet.kind).toBe('action');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the typecheck battery compiles both shapes, so tsc has the second one too', () => {
    // Pinned here rather than trusted: the contract gate compiles whatever the fixture lists, and
    // a fixture that lists only the slice `x g resource` wrote compiles only the shape that never
    // failed.
    expect(sliceExports(HANDWRITTEN_ERRORS, 'InvoiceNotFoundError')).toBe(false);
  });
});
